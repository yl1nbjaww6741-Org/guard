// The privileged half of NSFW detection - see offscreen.html's own
// comment for the split with sandbox/sandbox.js. This file: captures
// screenshots (chrome.tabs.captureVisibleTab, needs chrome.* access),
// decodes them to raw pixel data, and hands that to the sandboxed iframe
// for actual classification via postMessage. On a real detection, tells
// the service worker which tab to close - reuses the exact same
// close-the-tab mechanism content-scripts/keyword-blocker.js's matches
// already trigger (see service-worker.js's onMessage listener), same
// "close the tab immediately" reasoning from this project's own
// 2026-08-25 decision either way.

const CAPTURE_INTERVAL_MS = 5000; // Matches ContentGuardConfig.captureIntervalSeconds
// (mac/Shared/Config.swift) exactly - the whole point of this feature
// being "same 5 second capture" as the native Mac agent. Verified
// feasible against chrome.tabs.captureVisibleTab's real, documented rate
// limit (~2 calls/second, introduced Chrome 92) - even capturing several
// windows every tick stays nowhere near that ceiling.

const sandboxFrame = document.getElementById("sandbox-frame");
let sandboxReady = false;
let pendingRequests = new Map(); // requestId -> {resolve, reject}
let nextRequestId = 0;

// Two independent async things have to both finish before the sandbox
// can actually be initialized: the sandbox iframe announcing itself
// ready to receive messages, and the (slow - 99MB) model fetch below.
// They can finish in either order - trySendInit() only actually sends
// once both have. See init()'s own comment for the real bug this
// replaced (waiting on the iframe's "load" DOM event instead, which had
// a confirmed-live race where that event usually already fired by the
// time the model fetch finished, silently hanging forever with no
// error).
let sandboxLoaded = false;
let modelBytes = null;
function trySendInit() {
  if (!sandboxLoaded || !modelBytes) return;
  const bytes = modelBytes;
  modelBytes = null; // Consumed - postMessage's transfer list detaches
  // this ArrayBuffer from this context anyway, but clearing the
  // reference here too guards against a stray second trySendInit() call
  // trying to resend an already-transferred (and thus unusable) buffer.
  sandboxFrame.contentWindow.postMessage({ type: "contentguard-init", modelBytes: bytes }, "*", [bytes]);
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "contentguard-sandbox-loaded") {
    sandboxLoaded = true;
    trySendInit();
    return;
  }
  if (message.type === "contentguard-session-ready") {
    sandboxReady = true;
    console.log("ContentGuard: NudeNet ONNX session ready in sandbox");
    startCaptureLoop();
    return;
  }
  if (message.type === "contentguard-session-error") {
    // Fails closed by simply never starting the capture loop - no
    // detection ever fires, same as the native agent's own
    // classifier-load-failure path (main.swift's applicationDidFinishLaunching
    // catch block: "no local cover... daemon's heartbeat-based fail-
    // closed is the backstop"). This extension has no daemon-equivalent
    // backstop yet - a real, named gap, not hidden: if this fires, NSFW
    // detection silently isn't running at all, only keyword blocking
    // still is. Logged loudly so it's at least visible in the service
    // worker's console during testing.
    console.error("ContentGuard: sandbox session failed to initialize -", message.error, "- NSFW detection will NOT run this session (keyword blocking is unaffected)");
    return;
  }
  if (message.type === "contentguard-result") {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }
});

function classifyInSandbox(imageData) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    pendingRequests.set(requestId, { resolve, reject });
    sandboxFrame.contentWindow.postMessage({ type: "contentguard-classify", requestId, imageData }, "*");
  });
}

async function dataUrlToImageData(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function captureAndClassifyWindow(win) {
  let dataUrl;
  try {
    // format/quality: JPEG at 70, not PNG - this is fed straight into a
    // 640x640 float32 classifier, not shown to a human, so lossless
    // capture buys nothing here and PNG's larger payload only slows down
    // the decode step below for no benefit. Not yet confirmed this
    // quality level doesn't lose detail the classifier actually needs -
    // worth watching for a real detection gap during testing, same as
    // every other "reasoned but not yet independently verified" note in
    // this extension.
    dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "jpeg", quality: 70 });
  } catch (err) {
    // Real, expected failure modes, not bugs: a minimized window, a
    // chrome:// / Chrome Web Store page (captureVisibleTab is
    // documented as unable to capture those - nothing sensitive lives
    // there anyway), or a window with no active tab. Skip this window
    // for this tick rather than treating it as fatal to the whole loop.
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!activeTab) return;

  let imageData;
  try {
    imageData = await dataUrlToImageData(dataUrl);
  } catch (err) {
    console.warn("ContentGuard: failed to decode captured screenshot", err);
    return;
  }

  let result;
  try {
    result = await classifyInSandbox(imageData);
  } catch (err) {
    console.warn("ContentGuard: classification failed", err);
    return;
  }

  if (result.detected) {
    console.log(`ContentGuard: DETECTED - class=${result.detectionClass} confidence=${result.confidence} tab=${activeTab.id}`);
    chrome.runtime.sendMessage({ type: "contentguard-nsfw-detection", tabId: activeTab.id });
  }
}

let captureLoopStarted = false;
function startCaptureLoop() {
  if (captureLoopStarted) return; // Guards against a second
  // "contentguard-session-ready" message somehow re-arming a second
  // interval - should never happen (the sandbox only sends this once,
  // right after session creation succeeds), but a duplicated capture
  // loop would silently double every window's capture rate, worth
  // guarding cheaply against.
  captureLoopStarted = true;
  setInterval(async () => {
    if (!sandboxReady) return;
    const windows = await chrome.windows.getAll();
    // Sequential, not Promise.all - captureVisibleTab's own rate limit
    // (~2/second) means firing every window's capture simultaneously
    // could exceed it with more than 2 windows open; sequential capture
    // within a single 5-second tick has comfortable headroom regardless
    // of window count.
    for (const win of windows) {
      await captureAndClassifyWindow(win);
    }
  }, CAPTURE_INTERVAL_MS);
}

// CONFIRMED LIVE (real Mac, real Chrome, 2026-08-25) that the original
// version of this function had a real bug: it fetched the model, THEN
// registered a listener for the sandbox <iframe>'s own "load" DOM event
// before sending it. In practice the sandbox (a tiny page) finishes
// loading well before this function's 99MB fetch does - so by the time
// the listener was registered, "load" had already fired once and would
// never fire again, and init() just hung forever with nothing to catch
// or log (nothing ever threw). Symptom that gave it away: sandboxReady
// stayed false with zero console output, even re-invoking init()
// directly from DevTools. Fixed by having the sandbox announce itself
// via postMessage instead of relying on a DOM event at all - see
// trySendInit() above and sandbox.js's matching comment.
async function init() {
  try {
    const modelUrl = chrome.runtime.getURL("model/nudenet_640m.onnx");
    modelBytes = await (await fetch(modelUrl)).arrayBuffer();
    trySendInit();
  } catch (err) {
    console.error("ContentGuard: failed to load NudeNet model -", err, "- NSFW detection will NOT run this session (keyword blocking is unaffected)");
  }
}

init();
