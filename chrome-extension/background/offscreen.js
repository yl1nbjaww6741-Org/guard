// The DOM/classification half of NSFW detection - see offscreen.html's
// own comment for the split with sandbox/sandbox.js. This file: asks the
// service worker to actually capture screenshots (see below for why it
// can't do that itself), decodes them to raw pixel data, and hands that
// to the sandboxed iframe for classification via postMessage. On a real
// detection, tells the service worker which tab to close - reuses the
// exact same close-the-tab mechanism content-scripts/keyword-blocker.js's
// matches already trigger (see service-worker.js's onMessage listener),
// same "close the tab immediately" reasoning from this project's own
// 2026-08-25 decision either way.
//
// Does NOT call chrome.tabs/chrome.windows directly, despite this
// project's own manifest.json listing those permissions - CONFIRMED LIVE
// (real Mac, real Chrome, 2026-08-25: "Uncaught TypeError: Cannot read
// properties of undefined (reading 'getAll')" at chrome.windows.getAll())
// and independently confirmed against Chrome's own developer docs:
// offscreen documents only have access to chrome.runtime messaging -
// chrome.tabs and chrome.windows are simply not exposed there at all, a
// deliberate Chrome restriction so offscreen documents can't be used as
// a background-page replacement. requestCaptures() below asks
// service-worker.js (which DOES have full API access) to do the actual
// capturing instead.

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

// --- Change-hash + skin-tone prefilter ---
// Direct port of mac/ContentGuardAgent/Sources/FrameProcessor.swift's
// perceptualHash()/skinAnalysis() - same 8x8 average-luminance hash
// (hamming distance < 4 = "materially unchanged"), same YCbCr skin-tone
// heuristic over a 4x4 grid, same two real-data-tuned thresholds (0.15
// whole-thumbnail average, 0.35 densest single block - see that file's
// own doc comments for the actual Mac testing that produced these exact
// numbers; ported verbatim, not re-guessed). Runs on a cheap 64px
// thumbnail before ever touching the expensive sandbox/ONNX path -
// same "load shedder, not an acquitter" role as the Swift original: a
// frame that fails this prefilter is judged UNLIKELY to contain the
// target classes, never judged CLEAR of them - the full classifier is
// still the only thing that ever confirms a detection.
//
// BigInt for the hash, not a plain JS Number - Swift's UInt64 has 64
// real bits; JS's bitwise operators (<<, |) coerce to 32-bit signed
// integers and would silently corrupt a hash built past bit 31. BigInt
// has no such limit and supports the same << / | / ^ operators natively.
const CHANGE_HASH_THUMBNAIL_SIZE = 64;
const SKIN_RATIO_PREFILTER_THRESHOLD = 0.15;
const SKIN_RATIO_PREFILTER_BLOCK_THRESHOLD = 0.35;
const lastFrameHash = new Map(); // tabId -> BigInt

function perceptualHash(imageData) {
  const { data, width, height } = imageData;
  const luminances = [];
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x = Math.min(width - 1, Math.floor((gx * width) / 8));
      const y = Math.min(height - 1, Math.floor((gy * height) / 8));
      const offset = (y * width + x) * 4; // RGBA - canvas ImageData order,
      // NOT Swift's BGRA CVPixelBuffer order, so the channel indices
      // below are deliberately R=0, G=1, B=2, not the Swift file's B/G/R.
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      luminances.push(Math.round((r * 299 + g * 587 + b * 114) / 1000));
    }
  }
  const average = Math.floor(luminances.reduce((sum, l) => sum + l, 0) / luminances.length);
  let hash = 0n;
  luminances.forEach((luminance, index) => {
    if (luminance >= average) hash |= 1n << BigInt(index);
  });
  return hash;
}

function hammingDistance(a, b) {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

function skinAnalysis(imageData) {
  const { data, width, height } = imageData;
  const gridSize = 4;
  const blockSkinCounts = new Array(gridSize * gridSize).fill(0);
  const blockTotalCounts = new Array(gridSize * gridSize).fill(0);
  let totalSkinCount = 0;
  let totalCount = 0;

  for (let y = 0; y < height; y++) {
    const blockY = Math.min(gridSize - 1, Math.floor((y * gridSize) / height));
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4; // RGBA, see perceptualHash's own note
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      const cb = -0.169 * r - 0.331 * g + 0.5 * b + 128;
      const cr = 0.5 * r - 0.419 * g - 0.081 * b + 128;
      const isSkin = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;

      const blockX = Math.min(gridSize - 1, Math.floor((x * gridSize) / width));
      const blockIndex = blockY * gridSize + blockX;
      blockTotalCounts[blockIndex]++;
      totalCount++;
      if (isSkin) {
        blockSkinCounts[blockIndex]++;
        totalSkinCount++;
      }
    }
  }

  if (totalCount === 0) return { globalRatio: 1, maxBlockRatio: 1 }; // Can't
  // evaluate -> don't shed, same fail-open-to-classify direction as the
  // Swift original for this specific non-safety-critical prefilter stage.

  const globalRatio = totalSkinCount / totalCount;
  let maxBlockRatio = 0;
  for (let i = 0; i < gridSize * gridSize; i++) {
    if (blockTotalCounts[i] > 0) {
      maxBlockRatio = Math.max(maxBlockRatio, blockSkinCounts[i] / blockTotalCounts[i]);
    }
  }
  return { globalRatio, maxBlockRatio };
}

function drawToImageData(bitmap, targetWidth, targetHeight) {
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  return ctx.getImageData(0, 0, targetWidth, targetHeight);
}

// Round-trips to service-worker.js's own onMessage listener
// ("contentguard-capture-request" case) - see this file's own header
// comment for why the actual chrome.tabs/chrome.windows calls have to
// live there instead of here. Returns [{tabId, dataUrl}, ...], already
// filtered down to windows that had something capturable (a minimized
// window, chrome:// page, etc. is silently excluded on the service
// worker's side).
function requestCaptures() {
  return chrome.runtime.sendMessage({ type: "contentguard-capture-request" });
}

async function classifyCapture({ tabId, dataUrl }) {
  // One decode of the captured JPEG, reused for both the cheap
  // prefilter thumbnail AND (only if the prefilter doesn't skip) the
  // downscaled-for-the-model image below - never two separate decodes
  // of the same screenshot.
  let bitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    console.warn("ContentGuard: failed to decode captured screenshot", err);
    return;
  }

  const thumbScale = CHANGE_HASH_THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height);
  const thumbWidth = Math.max(1, Math.round(bitmap.width * thumbScale));
  const thumbHeight = Math.max(1, Math.round(bitmap.height * thumbScale));
  const thumbnail = drawToImageData(bitmap, thumbWidth, thumbHeight);

  const hash = perceptualHash(thumbnail);
  const lastHash = lastFrameHash.get(tabId);
  if (lastHash !== undefined && hammingDistance(hash, lastHash) < 4) {
    // Materially unchanged since the last capture of this same tab -
    // skip the rest of the pipeline entirely, same as
    // FrameProcessor.swift's own change-hash check. Pure performance
    // optimization, not a safety-relevant decision: if the frame didn't
    // change, whatever conclusion applied last time still applies.
    return;
  }
  lastFrameHash.set(tabId, hash);

  const { globalRatio, maxBlockRatio } = skinAnalysis(thumbnail);
  if (globalRatio < SKIN_RATIO_PREFILTER_THRESHOLD && maxBlockRatio < SKIN_RATIO_PREFILTER_BLOCK_THRESHOLD) {
    // Below both thresholds - skip the expensive sandbox/ONNX path
    // entirely, same as FrameProcessor.swift's own skin-tone prefilter.
    // Still a load shedder, not an acquitter - see this section's own
    // header comment.
    return;
  }

  // Passed both prefilters - downscale (reusing the SAME already-
  // decoded bitmap, no second JPEG decode) to the model's own <=640
  // budget before sending to the sandbox, rather than the full native
  // capture resolution. Same "don't move more pixels than the model can
  // use" reasoning as ContentGuardConfig.maxCaptureDimension - a Retina
  // screenshot can be several times 640px on its long side, and
  // sandbox.js's own preprocess() would otherwise have to downscale
  // (and this postMessage would have to transfer) that full size for
  // nothing, since the classifier is mathematically incapable of seeing
  // detail beyond its own 640x640 input.
  const modelScale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
  const modelWidth = Math.max(1, Math.round(bitmap.width * modelScale));
  const modelHeight = Math.max(1, Math.round(bitmap.height * modelScale));
  const imageData = drawToImageData(bitmap, modelWidth, modelHeight);

  let result;
  try {
    result = await classifyInSandbox(imageData);
  } catch (err) {
    console.warn("ContentGuard: classification failed", err);
    return;
  }

  if (result.detected) {
    console.log(`ContentGuard: DETECTED - class=${result.detectionClass} confidence=${result.confidence} tab=${tabId}`);
    chrome.runtime.sendMessage({ type: "contentguard-nsfw-detection", tabId });
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
    let captures;
    try {
      captures = await requestCaptures();
    } catch (err) {
      console.warn("ContentGuard: capture request to service worker failed", err);
      return;
    }
    // Sequential, not Promise.all - classifyCapture ultimately round-
    // trips through the sandbox iframe for real ONNX inference, which
    // has no benefit (and real cost - competing WASM work) running
    // several captures at once; the whole point of a 5-second cadence
    // is that this has comfortable headroom to run one at a time.
    for (const capture of captures ?? []) {
      await classifyCapture(capture);
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
