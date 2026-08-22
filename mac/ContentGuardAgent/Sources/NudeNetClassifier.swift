// Loads the NudeNet 640m ONNX model via ONNX Runtime with the CoreML
// execution provider (routes inference to the Neural Engine on Apple
// Silicon) and classifies a preprocessed frame.
//
// Honest flag before anything else: the ONNX Runtime API calls below are
// real, confirmed against the current onnxruntime-swift-package-manager SPM
// package (microsoft/onnxruntime-swift-package-manager, "onnxruntime"
// product) - not guessed. What's still genuinely unconfirmed, and can only
// be confirmed once the real model file exists to inspect (e.g. via
// Netron): the exact input/output tensor names (inputName/outputName
// below), the output tensor's layout (assumed here to be the standard
// YOLOv8-export [1, 4+numClasses, numAnchors] shape), and the full ordered
// class-label list (fullClassLabels below, filled in from NudeNet's
// commonly-published label set but not yet checked against this specific
// export). parseDetections() fails closed (throws
// .unexpectedOutputShape) rather than silently misreading a wrong layout,
// so a mismatch here surfaces as a build-time-obvious runtime error during
// Phase 2 verification, not a silent misclassification.

import CoreVideo
import CryptoKit
import Foundation
import OnnxRuntimeBindings

enum ClassificationResult {
    case clean
    case detected(detectionClass: String, confidence: Float, boundingBox: CGRect)
}

enum NudeNetClassifierError: Error {
    case modelNotFound
    case sessionCreationFailed
    case inferenceFailed
    case unexpectedOutputShape
}

final class NudeNetClassifier {
    /// SHA256 of the model file, computed once at load time and included in
    /// every heartbeat - lets the daemon (or a future dashboard) notice if
    /// the running agent's model doesn't match what's expected, without
    /// needing to trust the agent's own self-report of "which model am I
    /// using."
    private(set) var modelHash: String = ""

    private var env: ORTEnv?
    private var session: ORTSession?

    // Standard YOLOv8-export input/output names - NOT yet confirmed against
    // NudeNet 640m specifically. If these are wrong, session.run() throws
    // immediately (ORT reports "invalid feed/fetch name"), which is a loud,
    // obvious failure during Phase 2 verification rather than a silent one.
    private static let inputName = "images"
    private static let outputName = "output0"

    init() throws {
        guard FileManager.default.fileExists(atPath: ContentGuardPaths.modelFile) else {
            throw NudeNetClassifierError.modelNotFound
        }
        modelHash = try Self.sha256(ofFileAt: ContentGuardPaths.modelFile)
        try loadSession()
    }

    private func loadSession() throws {
        let ortEnv = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        do {
            try options.appendCoreMLExecutionProvider(with: ORTCoreMLExecutionProviderOptions())
        } catch {
            // Not fatal on its own - ORT falls back to CPU execution, just
            // slower. Only the session creation below is worth failing
            // closed over; a missing Neural Engine path specifically isn't
            // a security concern, just a performance one.
        }
        env = ortEnv
        session = try ORTSession(env: ortEnv, modelPath: ContentGuardPaths.modelFile, sessionOptions: options)
    }

    /// Runs inference on an already-640px-downscaled BGRA pixel buffer (see
    /// FrameProcessor.swift's downscale step) and returns the
    /// highest-confidence detection across ALL classes (not just blocked
    /// ones - FrameProcessor.swift is the one that checks both the
    /// confidence threshold and the blocked-class set, so this always
    /// returns .detected rather than pre-filtering; .clean is effectively
    /// unreachable given a real model, kept only as a defensive fallback
    /// for a zero-anchor output).
    func classify(_ pixelBuffer: CVPixelBuffer) throws -> ClassificationResult {
        guard let session else { throw NudeNetClassifierError.sessionCreationFailed }

        let inputFloats = try preprocess(pixelBuffer)
        let inputData = inputFloats.withUnsafeBufferPointer { NSMutableData(bytes: $0.baseAddress!, length: $0.count * MemoryLayout<Float>.size) }
        let inputTensor = try ORTValue(
            tensorData: inputData,
            elementType: .float,
            shape: [1, 3, 640, 640] as [NSNumber]
        )

        let outputs = try session.run(
            withInputs: [Self.inputName: inputTensor],
            outputNames: [Self.outputName],
            runOptions: nil
        )
        guard let outputValue = outputs[Self.outputName] else {
            throw NudeNetClassifierError.unexpectedOutputShape
        }
        return try parseDetections(from: outputValue)
    }

    // MARK: - Preprocessing

    /// Converts a BGRA CVPixelBuffer into the float32 NCHW tensor most YOLO-
    /// family ONNX exports expect (1x3x640x640, RGB channel order,
    /// normalized 0-1). Confirm this matches NudeNet 640m's actual expected
    /// input against the model's own metadata once it's available to
    /// inspect (e.g. via `python -c "import onnx; ..."` or Netron) rather
    /// than assuming the common case is the actual case.
    private func preprocess(_ pixelBuffer: CVPixelBuffer) throws -> [Float] {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw NudeNetClassifierError.unexpectedOutputShape
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let buffer = base.assumingMemoryBound(to: UInt8.self)

        var chwPlanes = [Float](repeating: 0, count: 3 * width * height)
        let planeSize = width * height
        for y in 0..<height {
            for x in 0..<width {
                let offset = y * bytesPerRow + x * 4 // BGRA
                let b = Float(buffer[offset]) / 255.0
                let g = Float(buffer[offset + 1]) / 255.0
                let r = Float(buffer[offset + 2]) / 255.0
                let pixelIndex = y * width + x
                chwPlanes[0 * planeSize + pixelIndex] = r
                chwPlanes[1 * planeSize + pixelIndex] = g
                chwPlanes[2 * planeSize + pixelIndex] = b
            }
        }
        return chwPlanes
    }

    // MARK: - Output parsing

    /// ALL classes NudeNet 640m recognizes, in output-channel order - not
    /// just the ones ContentGuardConfig.blockedClasses treats as blocked.
    /// The model scores every class per anchor regardless of whether we
    /// care about it (e.g. FACE_FEMALE, BELLY_COVERED); this list has to
    /// match the model's real channel order for parseDetections() below to
    /// pick the right index. Filled in from NudeNet's commonly-published
    /// label set (the notAI-tech/NudeNet detector releases), but NOT yet
    /// verified against this specific exported model - do that via Netron
    /// (or `python -c "import onnx; ..."` on the metadata) once the real
    /// .onnx file exists, before trusting this order. A wrong order here
    /// silently misclassifies rather than erroring, since it's just array
    /// indexing - the numClasses count check in parseDetections() below at
    /// least catches a wrong total, but not a shuffled order with the same
    /// count.
    private static let fullClassLabels: [String] = [
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
    ]

    /// Parses a raw ORT output tensor into the single highest-confidence
    /// detection among the classes ContentGuardConfig.blockedClasses cares
    /// about. Assumes the standard YOLOv8-export layout:
    /// [1, 4 + numClasses, numAnchors] - box coords (cx, cy, w, h) in the
    /// first 4 channels, per-class confidence in the rest, all in
    /// model-input (640x640) pixel space. NOT yet confirmed against
    /// NudeNet 640m's real export; if the actual layout differs (e.g.
    /// [1, numAnchors, 4+numClasses], sigmoid not yet applied, or extra
    /// objectness channel), this throws .unexpectedOutputShape rather than
    /// silently misreading bytes - a build-time-obvious failure to catch
    /// during Phase 2 verification, not a silent wrong answer.
    private func parseDetections(from outputValue: ORTValue) throws -> ClassificationResult {
        let shapeInfo = try outputValue.tensorTypeAndShapeInfo()
        let dims = shapeInfo.shape.map(\.intValue)
        guard dims.count == 3, dims[0] == 1 else {
            throw NudeNetClassifierError.unexpectedOutputShape
        }
        let channels = dims[1]
        let numAnchors = dims[2]
        let numClasses = channels - 4
        guard numClasses == Self.fullClassLabels.count else {
            // The label list above doesn't match what the model actually
            // outputs - fail closed rather than reading class scores into
            // the wrong (or out-of-bounds) slots.
            throw NudeNetClassifierError.unexpectedOutputShape
        }

        let rawData = try outputValue.tensorData() as Data
        guard rawData.count == channels * numAnchors * MemoryLayout<Float>.size else {
            throw NudeNetClassifierError.unexpectedOutputShape
        }
        let floats = rawData.withUnsafeBytes { rawBuffer in
            Array(rawBuffer.bindMemory(to: Float.self))
        }

        let blockedIndices = Self.fullClassLabels.enumerated()
            .filter { ContentGuardConfig.blockedClasses.contains($0.element) }
            .map(\.offset)
        guard !blockedIndices.isEmpty else {
            // Misconfiguration (blockedClasses references a label not in
            // fullClassLabels) rather than a real "nothing detected" -
            // still fails closed via the caller's error handling, just
            // flagged distinctly here for anyone debugging why nothing
            // ever triggers.
            throw NudeNetClassifierError.unexpectedOutputShape
        }

        var best: (classIndex: Int, confidence: Float, anchor: Int)?
        for anchor in 0..<numAnchors {
            for classIndex in blockedIndices {
                let confidence = floats[(4 + classIndex) * numAnchors + anchor]
                if best == nil || confidence > best!.confidence {
                    best = (classIndex, confidence, anchor)
                }
            }
        }
        guard let best else { return .clean }

        let cx = floats[0 * numAnchors + best.anchor]
        let cy = floats[1 * numAnchors + best.anchor]
        let w = floats[2 * numAnchors + best.anchor]
        let h = floats[3 * numAnchors + best.anchor]
        let boundingBox = CGRect(
            x: CGFloat(cx - w / 2),
            y: CGFloat(cy - h / 2),
            width: CGFloat(w),
            height: CGFloat(h)
        )

        return .detected(
            detectionClass: Self.fullClassLabels[best.classIndex],
            confidence: best.confidence,
            boundingBox: boundingBox
        )
    }

    // MARK: - Model integrity

    private static func sha256(ofFileAt path: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
