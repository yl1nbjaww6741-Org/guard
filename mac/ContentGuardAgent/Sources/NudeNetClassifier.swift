// Loads the NudeNet 640m ONNX model via ONNX Runtime with the CoreML
// execution provider (routes inference to the Neural Engine on Apple
// Silicon) and classifies a preprocessed frame.
//
// Honest flag before anything else: this file is written against the
// general shape of ONNX Runtime's Objective-C/Swift API
// (onnxruntime-objc / the onnxruntime-swift-package-manager SPM package) -
// exact class/method names can shift between ONNX Runtime versions, and the
// exact output tensor layout (box format, class order, anchor/stride
// scheme) depends on how NudeNet 640m was actually exported. Both need
// confirming against the real SPM dependency and the real model file once
// they're in the Xcode project - not something to assume correct from this
// sandbox, which has no way to run either. Where this file is uncertain,
// it's uncertain on purpose and says so, rather than presenting a guess as
// settled.

import CoreVideo
import CryptoKit
import Foundation
// import onnxruntime_objc // add via Swift Package Manager - see file doc comment

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

    // TODO once onnxruntime-objc is added as an SPM dependency:
    //   private var session: ORTSession?
    //   private var env: ORTEnv?

    init() throws {
        guard FileManager.default.fileExists(atPath: ContentGuardPaths.modelFile) else {
            throw NudeNetClassifierError.modelNotFound
        }
        modelHash = try Self.sha256(ofFileAt: ContentGuardPaths.modelFile)
        try loadSession()
    }

    private func loadSession() throws {
        // TODO once onnxruntime-objc is in the project:
        //
        //   env = try ORTEnv(loggingLevel: .warning)
        //   let options = try ORTSessionOptions()
        //   // Route inference to the Neural Engine on Apple Silicon rather
        //   // than CPU - confirm the exact provider-options type/enablement
        //   // call against whatever onnxruntime-objc version actually
        //   // resolves; this is the one call in this file most likely to
        //   // have shifted across ORT versions.
        //   try options.appendCoreMLExecutionProvider(with: ORTCoreMLExecutionProviderOptions())
        //   session = try ORTSession(env: env!, modelPath: ContentGuardPaths.modelFile, sessionOptions: options)
        //
        // Left unimplemented rather than faked, since a stub that "succeeds"
        // silently would be worse than an explicit gap - FrameProcessor's
        // caller already treats a thrown error here as fail-closed (see
        // FrameProcessor.swift's catch block), so until this is wired up,
        // every frame correctly triggers the uncertain->positive path
        // rather than pretending to classify.
        throw NudeNetClassifierError.sessionCreationFailed
    }

    /// Runs inference on an already-640px-downscaled BGRA pixel buffer (see
    /// FrameProcessor.swift's downscale step) and returns the
    /// highest-confidence blocked-class detection, if any.
    func classify(_ pixelBuffer: CVPixelBuffer) throws -> ClassificationResult {
        let inputTensor = try preprocess(pixelBuffer)

        // TODO once the session exists:
        //   let outputs = try session!.run(withInputs: ["images": inputTensor], outputNames: ["output0"], runOptions: nil)
        //   return try parseDetections(from: outputs)
        _ = inputTensor
        throw NudeNetClassifierError.inferenceFailed
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

    /// Detection class labels, in the order the spec lists them - NOT
    /// necessarily the order the model's own output uses. This needs
    /// cross-checking against the model's actual class index mapping
    /// (typically documented alongside the model export, e.g. a labels.txt
    /// or embedded in the ONNX metadata) before relying on it - a
    /// class-index mismatch here would silently misclassify rather than
    /// error, which is exactly the kind of bug that's invisible until
    /// tested against real frames.
    private static let blockedClassLabels: [String] = [
        "FEMALE_BREAST_EXPOSED",
        "FEMALE_GENITALIA_EXPOSED",
        "MALE_GENITALIA_EXPOSED",
        "BUTTOCKS_EXPOSED",
        "ANUS_EXPOSED",
    ]

    // MARK: - Model integrity

    private static func sha256(ofFileAt path: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
