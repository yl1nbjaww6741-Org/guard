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

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

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

async function init() {
  try {
    const modelUrl = chrome.runtime.getURL("model/nudenet_640m.onnx");
    const modelBytes = await (await fetch(modelUrl)).arrayBuffer();
    // Wait for the sandbox iframe's own "load" event, not its
    // contentDocument.readyState - the sandbox has its own opaque/unique
    // origin (see sandbox.html's own comment), so reading
    // contentDocument cross-origin from here isn't reliable. The <iframe>
    // element's own "load" DOM event fires regardless of the framed
    // document's origin, and by the time it fires sandbox.js's module
    // script (a synchronous <script type=module>, blocking parse until
    // executed) has already run and attached its message listener - a
    // message posted before that listener exists would simply be lost,
    // not queued, so this ordering matters.
    sandboxFrame.addEventListener("load", () => {
      sandboxFrame.contentWindow.postMessage({ type: "contentguard-init", modelBytes }, "*", [modelBytes]);
    });
  } catch (err) {
    console.error("ContentGuard: failed to load NudeNet model -", err, "- NSFW detection will NOT run this session (keyword blocking is unaffected)");
  }
}

init();
