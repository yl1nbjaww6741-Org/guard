// MV3 background service worker. No persistent DOM/global state survives
// between wake-ups by design (MV3 suspends this worker when idle) - the
// only durable state is chrome.storage.local (workerUrl/syncToken from
// the options page, and the last-synced keyword list). Every function
// below re-reads storage rather than relying on in-memory state left
// over from a previous wake-up.
//
// Keyword blocking was briefly removed entirely (see git history for
// 30a332e) after a real, self-inflicted bug - the dashboard's own
// Keyword blocker page necessarily rendered every blocked keyword as
// plain page text, so this extension's own filter started blocking the
// dashboard itself the moment a real keyword went on the list. Re-added
// 2026-09-04 with that bug's actual fix baked in from the start (see
// syncKeywords()'s own comment on excludedRequestDomains below), plus an
// explicit guarantee this project didn't previously spell out as
// deliberately as it should have: a keyword only ever matches as its
// FULL, exact phrase - see syncKeywords()'s own comment on urlFilter,
// and content-scripts/keyword-blocker.js's matching comment for the
// page-text half of this same guarantee.
//
// clearStaleDynamicRules() below (kept from the removal-and-reintroduction
// in between) is why the "declarativeNetRequest" permission being
// declared has never actually been in doubt: Chrome's own dynamic-rule
// storage is PERSISTENT ACROSS EXTENSION UPDATES (confirmed against
// Chrome's own declarativeNetRequest docs, not assumed), so a version
// that stopped calling updateDynamicRules() for a while does NOT
// retroactively clear whatever an earlier version already registered.
// Running it before syncKeywords() re-establishes the current rule set
// on every install/startup means this can never regress the same way
// again, regardless of what happens to this feature in the future.
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
//    limits) - both alarm periods below are set comfortably above every
//    documented floor, but hasn't been confirmed against a real
//    enterprise-forced install specifically.

const OFFSCREEN_HEALTHCHECK_ALARM_NAME = "contentguard-offscreen-healthcheck";
const OFFSCREEN_HEALTHCHECK_PERIOD_MINUTES = 5; // No hard requirement
// behind this specific number - just a reasonable cadence for "how long
// could the offscreen document sit dead before its absence matters" (see
// the alarm listener below).

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

// See this file's own header for why this exists at all - a real, live-
// found bug, not a hypothetical. Reads back whatever's currently
// registered and removes all of it; a completely empty ruleset (the
// normal case from here on, once this has run once on the affected
// install) makes this a fast no-op, not something worth skipping via
// some "have I already done this" flag.
async function clearStaleDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id) });
  console.log(`ContentGuard: cleared ${existing.length} stale declarativeNetRequest rule(s) left over from the removed keyword-blocking feature`);
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
  // workerUrl IS the dashboard's own origin (options.js saves the exact
  // same panel URL this fetch just hit) - excluded from every keyword
  // rule below for the same reason keyword-blocker.js's content script
  // exempts it from its own page-text scan (see that file's matching
  // comment): the dashboard necessarily renders each blocked keyword as
  // plain text (that's the whole point of the Keyword blocker section),
  // so without this a keyword worth blocking would also block the page
  // used to manage it. Derived from workerUrl, not hardcoded, so it
  // tracks whichever domain is actually configured (custom domain or
  // the *.workers.dev fallback) rather than going stale if that changes.
  // This is the real fix for the bug that got keyword blocking removed
  // entirely once already (see git history for 30a332e) - present here
  // from this reintroduction's very first commit, not bolted on after
  // the fact a second time.
  let panelHostname = null;
  try {
    panelHostname = new URL(workerUrl).hostname;
  } catch {
    // Already validated by options.js's own `new URL(workerUrl)` check
    // before this was ever saved to storage - a malformed value here
    // would mean storage was edited outside the options page. Fails
    // toward no exemption (every rule still gets added, just without
    // excludedRequestDomains) rather than toward skipping the sync.
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  // urlFilter is set to the ENTIRE keyword string, unmodified - Chrome
  // treats a plain urlFilter with no "*"/"|"/"^" as a single contiguous
  // substring to match, never split on whitespace or any other
  // character (confirmed against Chrome's own declarativeNetRequest
  // urlFilter format docs). That's what guarantees a multi-word keyword
  // like "reddit media downloader" can only match a URL that contains
  // that exact phrase, contiguous, never a URL containing just one word
  // of it - explicit user requirement, 2026-09-04.
  const addRules = keywords.map((keyword) => ({
    id: ruleIdForKeyword(keyword),
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: keyword,
      resourceTypes: ["main_frame"], // Top-level navigation only - a
      // keyword incidentally present in a sub-resource URL (an ad
      // script, a tracking pixel) isn't the page the user is visiting.
      ...(panelHostname ? { excludedRequestDomains: [panelHostname] } : {}),
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

// Periodic offscreen-document health-check: re-creates it if it was ever
// unexpectedly closed (Chrome can reclaim one under real memory pressure
// even though it's not supposed to time out on its own the way this
// service worker does). ensureOffscreenDocument() is a no-op via
// hasDocument() the vast majority of ticks.
//
// One listener for both alarms - the healthcheck one above, and the
// keyword-sync one below (piggybacking a cheap offscreen-document
// health-check onto the same 5-minute sync tick would also work, but
// keeping them as two independently-created alarms, same as before the
// full removal, means either can be retimed later without touching the
// other).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OFFSCREEN_HEALTHCHECK_ALARM_NAME) {
    ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to re-create offscreen document", err));
  } else if (alarm.name === SYNC_ALARM_NAME) {
    syncKeywords().catch((err) => console.error("ContentGuard: keyword sync failed", err));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(OFFSCREEN_HEALTHCHECK_ALARM_NAME, { periodInMinutes: OFFSCREEN_HEALTHCHECK_PERIOD_MINUTES });
  chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_ALARM_PERIOD_MINUTES });
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to create offscreen document", err));
  // Clear first, then sync - if syncKeywords isn't configured yet
  // (options page never saved) it returns without touching rules at
  // all, so clearing first is what makes "not configured" actually mean
  // "blocking nothing" instead of leaving whatever rules happened to
  // survive from an earlier install/version. If it IS configured,
  // syncKeywords's own full replace (removeRuleIds + addRules in one
  // call) makes this ordering harmless either way.
  clearStaleDynamicRules()
    .catch((err) => console.error("ContentGuard: failed to clear stale declarativeNetRequest rules", err))
    .finally(() => syncKeywords().catch((err) => console.error("ContentGuard: keyword sync failed", err)));
});
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to create offscreen document", err));
  clearStaleDynamicRules()
    .catch((err) => console.error("ContentGuard: failed to clear stale declarativeNetRequest rules", err))
    .finally(() => syncKeywords().catch((err) => console.error("ContentGuard: keyword sync failed", err)));
});

// Saving the options page (workerUrl/syncToken) should take effect right
// away, not wait up to SYNC_ALARM_PERIOD_MINUTES for the next alarm tick.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.workerUrl || changes.syncToken)) {
    syncKeywords().catch((err) => console.error("ContentGuard: keyword sync failed", err));
  }
});

// Battery optimization #1, mirroring the native agent's biggest lever
// (AppScopeManager.swift's process-existence capture-pause gating -
// "pause entirely when nothing relevant is currently active", not just
// throttle). The closest achievable equivalent for a browser extension
// without a site/tab-level safe-list (which doesn't exist yet): if
// Chrome itself isn't even the frontmost application, nobody is looking
// at any of its content right now, so there's nothing at risk to
// capture. onFocusChanged fires with chrome.windows.WINDOW_ID_NONE
// specifically when focus moves to a different application entirely
// (not just a different Chrome window) - this is the one reliable
// signal a browser extension actually has for "the user isn't looking
// at Chrome right now" (no direct NSWorkspace-style "am I frontmost"
// query exists in the extension API surface). Starts true (optimistic),
// not false - the very first few capture ticks after a fresh service-
// worker wake should run normally rather than silently no-op before
// this listener has ever fired once; same "start permissive, tighten
// once a real signal arrives" reasoning as never guessing in the
// direction that could hide real content.
let chromeIsFocused = true;
chrome.windows.onFocusChanged.addListener((windowId) => {
  chromeIsFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
});

// The actual chrome.tabs/chrome.windows work for NSFW detection - has to
// live HERE, not in background/offscreen.js where it originally lived.
// CONFIRMED LIVE (real Mac, real Chrome, 2026-08-25 - the exact error
// was "Uncaught TypeError: Cannot read properties of undefined (reading
// 'getAll')" at chrome.windows.getAll() inside offscreen.html's own
// context) and independently confirmed against Chrome's own developer
// docs: offscreen documents only have access to chrome.runtime messaging
// - chrome.tabs and chrome.windows are simply not exposed there at all,
// a deliberate restriction so offscreen documents can't be used as a
// background-page replacement. background/offscreen.js now requests a
// capture via chrome.runtime.sendMessage and gets the screenshots back
// in the response, instead of calling these APIs itself.
async function captureAllWindows() {
  if (!chromeIsFocused) return [];

  const windows = await chrome.windows.getAll();
  const captures = [];
  // Sequential, not Promise.all - captureVisibleTab's own rate limit
  // (~2/second, introduced Chrome 92) means firing every window's
  // capture simultaneously could exceed it with more than 2 windows
  // open; sequential capture within a single 5-second tick has
  // comfortable headroom regardless of window count.
  for (const win of windows) {
    // Battery optimization #2: a minimized window's content is
    // definitionally not visible to the user - captureVisibleTab would
    // just fail on it anyway (this is one of Chrome's own documented
    // capture restrictions), so skip the attempt entirely rather than
    // pay for an API call already known to fail.
    if (win.state === "minimized") continue;

    let dataUrl;
    try {
      // format/quality: JPEG at 70, not PNG - this is fed straight into
      // a 640x640 float32 classifier, not shown to a human, so lossless
      // capture buys nothing here. Not yet confirmed this quality level
      // doesn't lose detail the classifier actually needs.
      dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "jpeg", quality: 70 });
    } catch (err) {
      // Real, expected failure modes, not bugs: a chrome:// / Chrome Web
      // Store page (captureVisibleTab is documented as unable to
      // capture those - nothing sensitive lives there anyway), or a
      // window with no active tab. Skip this window for this tick
      // rather than treating it as fatal to the whole loop.
      continue;
    }
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!activeTab) continue;
    captures.push({ tabId: activeTab.id, dataUrl });
  }
  return captures;
}

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    return;
  }
  // background/offscreen.js's capture loop asking THIS context (which
  // has full chrome.tabs/chrome.windows access, unlike the offscreen
  // document itself - see captureAllWindows()'s own comment) to actually
  // do the screenshotting. Classic async-sendResponse pattern (return
  // true synchronously, call sendResponse from inside the .then()) -
  // deliberately not the newer "async listener returns a Promise
  // directly" style, to avoid any doubt about cross-Chrome-version
  // support for a message path this whole feature depends on.
  if (message?.type === "contentguard-capture-request") {
    captureAllWindows()
      .then(sendResponse)
      .catch((err) => {
        console.error("ContentGuard: captureAllWindows failed", err);
        sendResponse([]);
      });
    return true;
  }
});
