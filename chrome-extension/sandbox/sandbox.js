// Runs entirely inside sandbox.html's relaxed-CSP, chrome.*-API-less
// context (see that file's own header comment for why). Talks to
// ../background/offscreen.js purely via window.postMessage - never
// chrome.runtime.sendMessage, which isn't available here at all.
//
// Message protocol (offscreen.js -> this sandbox, via
// iframe.contentWindow.postMessage; this sandbox -> offscreen.js via
// window.parent.postMessage):
//   out: { type: "contentguard-sandbox-loaded" } (sent once, immediately -
//         see below for why this replaced waiting on the iframe's own
//         "load" DOM event)
//   in:  { type: "contentguard-init", modelBytes: ArrayBuffer }
//   out: { type: "contentguard-session-ready" } | { type: "contentguard-session-error", error: string }
//   in:  { type: "contentguard-classify", requestId, imageData: ImageData }
//   out: { type: "contentguard-result", requestId, result: { detected, detectionClass, confidence } }
//
// Preprocessing/postprocessing below is a direct port of
// mac/ContentGuardAgent/Sources/NudeNetClassifier.swift's preprocess()/
// parseDetections() - same model, same input shape, same letterbox-pad-
// top-left approach, same class label list/order, same blocked-class
// confidence-threshold logic. Kept in sync by hand (no shared source
// between Swift and this file) - if Config.swift's blockedClasses or
// detectionConfidenceThreshold ever change, this needs the matching edit.

import * as ort from "../lib/ort/ort.wasm.min.mjs";

// No explicit wasmPaths override - CONFIRMED LIVE (real Mac, real
// Chrome, 2026-08-25) that the original "../lib/ort/" value here was
// wrong: ORT resolves a relative wasmPaths against its OWN module's URL
// (import.meta.url of ort.wasm.min.mjs itself, which already lives at
// .../lib/ort/ort.wasm.min.mjs), not against sandbox.js/sandbox.html's
// location the way this comment originally (wrongly) assumed. That
// produced a doubled chrome-extension://<id>/lib/lib/ort/... path and a
// real "Failed to fetch dynamically imported module" error. ORT's own
// default behavior - resolve sibling files relative to its own script
// location - already finds ort-wasm-simd-threaded.wasm/.mjs correctly
// with zero configuration, since they live right next to
// ort.wasm.min.mjs in this same lib/ort/ directory. Leaving this comment
// (not deleting it silently) so a future "let's make this explicit
// again" doesn't reintroduce the exact same doubled-path bug.
// numThreads: 1 is load-bearing, not a performance tweak - see
// ../manifest.json's sandbox comment: ONNX Runtime Web's own thread-pool
// setup (spawning real Web Workers) is the specific thing that violates
// MV3's CSP even inside an offscreen document. Forcing single-threaded
// avoids that code path entirely rather than relying on the sandbox's
// relaxed CSP to tolerate it - belt and suspenders, since this hasn't
// been confirmed against a real Chrome install yet (no browser available
// while writing this).
ort.env.wasm.numThreads = 1;

const MODEL_INPUT_SIZE = 640;
const DETECTION_CONFIDENCE_THRESHOLD = 0.6; // Config.swift's detectionConfidenceThreshold
const BLOCKED_CLASSES = new Set([
  "FEMALE_BREAST_EXPOSED",
  "FEMALE_GENITALIA_EXPOSED",
  "MALE_GENITALIA_EXPOSED",
  "BUTTOCKS_EXPOSED",
  "ANUS_EXPOSED",
]); // Config.swift's blockedClasses, verbatim

// NudeNetClassifier.swift's fullClassLabels, verbatim - output-channel
// order, confirmed against the official notAI-tech/NudeNet Python
// client's own __labels list, not guessed (see that Swift file's own
// comment for the source).
const FULL_CLASS_LABELS = [
  "FEMALE_GENITALIA_COVERED",
  "FACE_FEMALE",
  "BUTTOCKS_EXPOSED",
  "FEMALE_BREAST_EXPOSED",
  "FEMALE_GENITALIA_EXPOSED",
  "MALE_BREAST_EXPOSED",
  "ANUS_EXPOSED",
  "FEET_EXPOSED",
  "BELLY_COVERED",
  "FEET_COVERED",
  "ARMPITS_COVERED",
  "ARMPITS_EXPOSED",
  "FACE_MALE",
  "BELLY_EXPOSED",
  "MALE_GENITALIA_EXPOSED",
  "ANUS_COVERED",
  "FEMALE_BREAST_COVERED",
  "BUTTOCKS_COVERED",
];
const BLOCKED_CLASS_INDICES = FULL_CLASS_LABELS
  .map((label, index) => ({ label, index }))
  .filter(({ label }) => BLOCKED_CLASSES.has(label))
  .map(({ index }) => index);

let session = null;
let inputName = null;
let outputName = null;

/// Direct port of NudeNetClassifier.swift's preprocess() - downscale so
/// the longer side is exactly MODEL_INPUT_SIZE (preserving aspect
/// ratio), then place that scaled image in the TOP-LEFT of a zero-filled
/// (black) 640x640 canvas, matching cv2.copyMakeBorder's default
/// bottom/right-only padding (the official Python client's own
/// preprocessing - see the Swift file's comment). Canvas 2D handles the
/// actual scaling (drawImage does bilinear resampling), rather than the
/// manual nearest-neighbor-by-hand a byte loop would need - Canvas
/// wasn't available to the Swift side (CVPixelBuffer/CoreImage territory
/// there instead), but is the natural tool here.
function preprocess(imageData) {
  const { width: origW, height: origH } = imageData;
  const scale = MODEL_INPUT_SIZE / Math.max(origW, origH);
  const scaledW = Math.max(1, Math.round(origW * scale));
  const scaledH = Math.max(1, Math.round(origH * scale));

  const sourceCanvas = new OffscreenCanvas(origW, origH);
  sourceCanvas.getContext("2d").putImageData(imageData, 0, 0);

  const canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black"; // Explicit - OffscreenCanvas starts fully
  // transparent, not black; cv2.copyMakeBorder's default fill (what
  // this is matching) is black, and a transparent-then-composited pixel
  // would NOT reliably read back as (0,0,0) once getImageData below
  // pulls it as opaque RGBA.
  ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  ctx.drawImage(sourceCanvas, 0, 0, scaledW, scaledH); // Top-left, not
  // centered - matches copyMakeBorder's own bottom/right-only padding.

  const padded = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const rgba = padded.data;

  // RGBA -> float32 NCHW, RGB order, normalized 0-1 - same layout
  // Swift's preprocess() builds by hand.
  const planeSize = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const chw = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    const rgbaOffset = i * 4;
    chw[0 * planeSize + i] = rgba[rgbaOffset] / 255; // R
    chw[1 * planeSize + i] = rgba[rgbaOffset + 1] / 255; // G
    chw[2 * planeSize + i] = rgba[rgbaOffset + 2] / 255; // B
  }
  return chw;
}

/// Direct port of NudeNetClassifier.swift's parseDetections() - assumes
/// the standard YOLOv8-export layout [1, 4 + numClasses, numAnchors]
/// (box coords in the first 4 channels, per-class confidence in the
/// rest). Scans every anchor for the single highest-confidence detection
/// among BLOCKED_CLASS_INDICES only - matches the Swift side exactly,
/// including only ever caring about blocked classes, never the full set.
function parseDetections(outputTensor) {
  const dims = outputTensor.dims;
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`unexpected output shape: [${dims.join(", ")}]`);
  }
  const channels = dims[1];
  const numAnchors = dims[2];
  const numClasses = channels - 4;
  if (numClasses !== FULL_CLASS_LABELS.length) {
    throw new Error(`model reports ${numClasses} classes, expected ${FULL_CLASS_LABELS.length} - label list is out of sync`);
  }

  const floats = outputTensor.data; // Float32Array

  let best = null;
  for (let anchor = 0; anchor < numAnchors; anchor++) {
    for (const classIndex of BLOCKED_CLASS_INDICES) {
      const confidence = floats[(4 + classIndex) * numAnchors + anchor];
      if (best === null || confidence > best.confidence) {
        best = { classIndex, confidence };
      }
    }
  }
  if (best === null) {
    return { detected: false };
  }
  return {
    detected: best.confidence > DETECTION_CONFIDENCE_THRESHOLD,
    detectionClass: FULL_CLASS_LABELS[best.classIndex],
    confidence: best.confidence,
  };
}

async function classify(imageData) {
  const inputFloats = preprocess(imageData);
  const inputTensor = new ort.Tensor("float32", inputFloats, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const outputs = await session.run({ [inputName]: inputTensor });
  return parseDetections(outputs[outputName]);
}

window.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "contentguard-init") {
    try {
      session = await ort.InferenceSession.create(message.modelBytes, { executionProviders: ["wasm"] });
      // Resolved dynamically from the session itself, same reasoning as
      // NudeNetClassifier.swift's own inputName/outputName - removes a
      // whole class of "guessed the wrong literal name" risk.
      inputName = session.inputNames[0];
      outputName = session.outputNames[0];
      if (!inputName || !outputName) {
        throw new Error("model session has no inputs/outputs");
      }
      window.parent.postMessage({ type: "contentguard-session-ready" }, "*");
    } catch (err) {
      window.parent.postMessage({ type: "contentguard-session-error", error: String(err) }, "*");
    }
    return;
  }

  if (message.type === "contentguard-classify") {
    const { requestId, imageData } = message;
    try {
      const result = await classify(imageData);
      window.parent.postMessage({ type: "contentguard-result", requestId, result }, "*");
    } catch (err) {
      window.parent.postMessage({ type: "contentguard-result", requestId, error: String(err) }, "*");
    }
  }
});

// Announces readiness explicitly, rather than offscreen.js waiting on
// the <iframe>'s own "load" DOM event - confirmed live (real Mac, real
// Chrome, 2026-08-25) that the "load" approach has a real race: by the
// time offscreen.js's model fetch finishes (a 99MB file, genuinely
// slow) and gets around to registering its "load" listener, this
// iframe's "load" event has USUALLY ALREADY FIRED (a small file, loads
// fast) - registering a listener for an event that already happened
// does nothing, so init() just hung forever with no error, since
// nothing ever threw. This message is sent unconditionally, the instant
// this script starts running (which is strictly after the "message"
// listener above is registered, same file, sequential execution) - so
// offscreen.js reacting to THIS instead of a DOM event has no
// equivalent race: this script cannot post the message before it's
// capable of receiving the reply.
window.parent.postMessage({ type: "contentguard-sandbox-loaded" }, "*");
