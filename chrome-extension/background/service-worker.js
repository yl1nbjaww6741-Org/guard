// MV3 background service worker. No persistent DOM/global state survives
// between wake-ups by design (MV3 suspends this worker when idle) - the
// only durable state is chrome.storage.local (workerUrl/syncToken from
// the options page, and the last-synced keyword list + the dynamic rule
// IDs currently registered from it). Every function below re-reads
// storage rather than relying on in-memory state left over from a
// previous wake-up.
//
// NOT YET LIVE-TESTED in a real Chrome browser (this was written without
// a real browser available to load an unpacked extension into) - flagging
// honestly rather than asserting confidence this project's own Mac-side
// code always earns from real hardware. Two things specifically worth
// confirming once loaded for real:
//  - declarativeNetRequest's urlFilter matching is documented by Chrome
//    as case-insensitive overall - assumed true here (keywords are
//    already lowercased server-side in keywordsApi.ts regardless, as a
//    belt-and-suspenders measure, not because this is unconfirmed).
//  - chrome.alarms' effective minimum period for a *published/policy-
//    installed* extension (vs. an unpacked dev-mode one, which has looser
//    limits) - SYNC_ALARM_PERIOD_MINUTES below is set comfortably above
//    every documented floor, but hasn't been confirmed against a real
//    enterprise-forced install specifically.

const SYNC_ALARM_NAME = "contentguard-keyword-sync";
const SYNC_ALARM_PERIOD_MINUTES = 5; // Matches ContentGuardAgent's own
// safe-apps sync poll cadence (AppScopeManager.swift's
// startSafeAppsSyncPoll, "up to 5 minutes later") - not a hard
// requirement they match, just a reasonable, already-established
// precedent for "how stale is acceptable" on this kind of dashboard-
// managed list.

// Dynamic rule IDs are deliberately derived from a stable hash of each
// keyword, not a simple array index - an index-based ID would shift out
// from under a rule if the keyword list's order or length changed
// between syncs (e.g. one keyword removed from the middle), making the
// removeRuleIds/addRules pair in syncKeywords() below potentially
// mismatched. A stable hash means the same keyword always gets the same
// rule ID across syncs, so removeRuleIds always targets exactly the
// rule a changed sync should replace.
function ruleIdForKeyword(keyword) {
  let hash = 2166136261; // FNV-1a, 32-bit
  for (let i = 0; i < keyword.length; i++) {
    hash ^= keyword.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // declarativeNetRequest rule IDs must be positive integers -
  // unsigned-shift off the sign bit, then keep well under
  // MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES's own ID space.
  return (hash >>> 1) || 1;
}

// The offscreen document (background/offscreen.html) is where the
// 5-second capture-and-classify loop actually lives - see that file's
// own comment for why (a persistent DOM context, unlike this service
// worker, which MV3 suspends when idle). Chrome allows exactly one
// offscreen document per extension; hasDocument() + this guard is the
// documented way to avoid a "document already exists" error from a
// second createDocument() call racing a first (e.g. onInstalled and
// onStartup both firing close together after a browser update).
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "background/offscreen.html",
    // WORKERS: onnxruntime-web's own thread-pool setup is real reason
    // this offscreen document exists (see offscreen.html's comment) -
    // this is a genuinely accurate justification, not just a best-fit
    // pick from chrome.offscreen.Reason's fairly narrow enum (confirmed
    // via Chrome's own extensions-reference docs: TESTING,
    // AUDIO_PLAYBACK, IFRAME_SCRIPTING, DOM_SCRAPING, BLOBS, DOM_PARSER,
    // USER_MEDIA, DISPLAY_MEDIA, WEB_RTC, CLIPBOARD, LOCAL_STORAGE,
    // WORKERS, BATTERY_STATUS, MATCH_MEDIA, GEOLOCATION - none of which
    // describe "long-running ML inference" directly, WORKERS is the
    // closest genuine match).
    reasons: ["WORKERS"],
    justification: "Runs the NudeNet ONNX classifier (via a sandboxed iframe) on a periodic tab-screenshot capture loop that must keep running across service-worker suspensions.",
  });
}

async function getConfig() {
  const stored = await chrome.storage.local.get(["workerUrl", "syncToken"]);
  return { workerUrl: stored.workerUrl ?? null, syncToken: stored.syncToken ?? null };
}

async function syncKeywords() {
  const { workerUrl, syncToken } = await getConfig();
  if (!workerUrl || !syncToken) {
    // Not configured yet (options page never saved) - nothing to sync,
    // nothing to block. Same "fails closed by doing nothing rather than
    // guessing" reasoning as every other unconfigured-secret path in
    // this project (see auth.ts's requireExtensionSyncToken on the
    // Worker side, which 503s rather than accepting an empty token).
    return;
  }

  let keywords;
  try {
    const res = await fetch(`${workerUrl}/sync/keywords`, {
      headers: { "X-ContentGuard-Extension-Token": syncToken },
    });
    if (!res.ok) {
      console.warn(`ContentGuard: keyword sync failed (${res.status})`);
      return;
    }
    const body = await res.json();
    keywords = Array.isArray(body.keywords) ? body.keywords : [];
  } catch (err) {
    console.warn("ContentGuard: keyword sync request failed", err);
    return;
  }

  // Replace ALL previously-registered dynamic rules with the new set in
  // one atomic call, rather than diffing add/remove - the rule count
  // here is small (this dashboard's own keyword list, meant to stay
  // short and deliberate, same philosophy as every other hand-curated
  // list in this project) so there's no meaningful cost to always doing
  // a full replace, and it can never drift out of sync with a
  // partially-applied diff.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = keywords.map((keyword) => ({
    id: ruleIdForKeyword(keyword),
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: keyword,
      resourceTypes: ["main_frame"], // Top-level navigation only - a
      // keyword incidentally present in a sub-resource URL (an ad
      // script, a tracking pixel) isn't the page the user is visiting.
    },
  }));
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    // A malformed urlFilter (Chrome has real syntax rules for this -
    // certain characters need escaping) would throw here. Logged rather
    // than silently dropped, but deliberately not fatal to the rest of
    // this sync - a bad rule for one keyword shouldn't block storage.set
    // below, which is what the content script's page-text scan (the
    // second half of keyword blocking) actually reads.
    console.warn("ContentGuard: updateDynamicRules failed", err);
  }

  await chrome.storage.local.set({ keywords });
}

// One listener for the sync alarm doing both its jobs - keyword sync,
// plus (piggybacking on the same 5-minute tick rather than a dedicated
// alarm) a cheap offscreen-document health-check: re-creates it if it
// was ever unexpectedly closed (Chrome can reclaim one under real memory
// pressure even though it's not supposed to time out on its own the way
// this service worker does). ensureOffscreenDocument() is a no-op via
// hasDocument() the vast majority of ticks.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM_NAME) return;
  syncKeywords();
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to re-create offscreen document", err));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_ALARM_PERIOD_MINUTES });
  syncKeywords();
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to create offscreen document", err));
});
chrome.runtime.onStartup.addListener(() => {
  syncKeywords();
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to create offscreen document", err));
});

// Saving the options page (workerUrl/syncToken) should take effect right
// away, not wait up to SYNC_ALARM_PERIOD_MINUTES for the next alarm tick.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.workerUrl || changes.syncToken)) {
    syncKeywords();
  }
});

// Shared by both reaction paths below - closing the tab, not covering/
// blurring it, per this project's own AskUserQuestion decision on
// 2026-08-25 ("close the tab immediately (Recommended)"), matching the
// native Mac agent's own disguise-over-blackout reasoning
// (main.swift's quitFrontmostApp doc comment) as closely as a browser
// extension can.
function closeTab(tabId) {
  chrome.tabs.remove(tabId).catch((err) => {
    // Tab may have already been closed/navigated away in the gap
    // between the match/detection and this message arriving - not an
    // error worth surfacing.
    console.warn("ContentGuard: failed to close tab", err);
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // content-scripts/keyword-blocker.js's page-text/title scan - fires
  // once it finds a match the URL-based declarativeNetRequest rule
  // didn't already catch (i.e. the keyword only appears in rendered
  // content, not the URL itself). tabId comes from sender.tab since
  // this message genuinely originates from that tab's own content
  // script context.
  if (message?.type === "contentguard-keyword-match" && sender.tab?.id != null) {
    closeTab(sender.tab.id);
    return;
  }
  // background/offscreen.js's NSFW classification loop - fires on a
  // real NudeNet detection above ContentGuardConfig.detectionConfidenceThreshold
  // for a blocked class. tabId is passed explicitly in the message
  // payload here, not read from sender.tab - this message originates
  // from the offscreen document (which captured a screenshot of some
  // OTHER tab), not from the detected tab's own content-script context,
  // so sender.tab would be wrong (or absent) here.
  if (message?.type === "contentguard-nsfw-detection" && typeof message.tabId === "number") {
    closeTab(message.tabId);
  }
});
