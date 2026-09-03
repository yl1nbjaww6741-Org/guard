// MV3 background service worker. No persistent DOM/global state survives
// between wake-ups by design (MV3 suspends this worker when idle) - this
// extension keeps no durable state at all (no chrome.storage use
// anywhere in it), so nothing here needs to re-read anything left over
// from a previous wake-up.
//
// NOT YET LIVE-TESTED in a real Chrome browser (this was written without
// a real browser available to load an unpacked extension into) - flagging
// honestly rather than asserting confidence this project's own Mac-side
// code always earns from real hardware. One thing specifically worth
// confirming once loaded for real: chrome.alarms' effective minimum
// period for a *published/policy-installed* extension (vs. an unpacked
// dev-mode one, which has looser limits) - OFFSCREEN_HEALTHCHECK_PERIOD_MINUTES
// below is set comfortably above every documented floor, but hasn't been
// confirmed against a real enterprise-forced install specifically.

const OFFSCREEN_HEALTHCHECK_ALARM_NAME = "contentguard-offscreen-healthcheck";
const OFFSCREEN_HEALTHCHECK_PERIOD_MINUTES = 5; // No hard requirement
// behind this specific number - just a reasonable cadence for "how long
// could the offscreen document sit dead before its absence matters" (see
// the alarm listener below).

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

// Periodic offscreen-document health-check: re-creates it if it was ever
// unexpectedly closed (Chrome can reclaim one under real memory pressure
// even though it's not supposed to time out on its own the way this
// service worker does). ensureOffscreenDocument() is a no-op via
// hasDocument() the vast majority of ticks.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== OFFSCREEN_HEALTHCHECK_ALARM_NAME) return;
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to re-create offscreen document", err));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(OFFSCREEN_HEALTHCHECK_ALARM_NAME, { periodInMinutes: OFFSCREEN_HEALTHCHECK_PERIOD_MINUTES });
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to create offscreen document", err));
});
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch((err) => console.error("ContentGuard: failed to create offscreen document", err));
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
