// Per-frame pipeline: skip frames that haven't materially changed, downscale
// for the classifier, cheaply prefilter on skin-tone ratio before spending a
// full NudeNet inference, then classify. Two different "when in doubt"
// policies apply at two different stages, deliberately not the same policy -
// see the comments on each.

import CoreImage
import CoreVideo
import Foundation

protocol FrameProcessorDelegate: AnyObject {
    func frameProcessor(_ processor: FrameProcessor, didDetect detection: BlackoutData, on displayID: CGDirectDisplayID)
    func frameProcessorDidProcessFrame(_ processor: FrameProcessor)
}

final class FrameProcessor {
    weak var delegate: FrameProcessorDelegate?

    private let classifier: NudeNetClassifier
    private let ciContext = CIContext()
    private var lastFrameHash: [CGDirectDisplayID: UInt64] = [:]
    private let processingQueue = DispatchQueue(label: "com.contentguard.agent.frame-processing", qos: .utility)

    /// Skin-tone prefilter threshold - deliberately permissive. This is a
    /// load shedder (skip obviously-safe frames to save a full inference),
    /// not an acquitter (it never gets to say "definitely clean" on its
    /// own) - see the module doc comment. Needs empirical tuning against
    /// real screenshots once running on the Mac; this starting value is a
    /// reasonable guess, not a measured one.
    private let skinRatioPrefilterThreshold: Double = 0.05

    init(classifier: NudeNetClassifier) {
        self.classifier = classifier
    }

    func process(pixelBuffer: CVPixelBuffer, displayID: CGDirectDisplayID) {
        processingQueue.async { [weak self] in
            self?.processOnQueue(pixelBuffer: pixelBuffer, displayID: displayID)
        }
    }

    private func processOnQueue(pixelBuffer: CVPixelBuffer, displayID: CGDirectDisplayID) {
        defer { delegate?.frameProcessorDidProcessFrame(self) }

        let thumbnail = downscale(pixelBuffer, targetDimension: 64)
        guard let thumbnail else {
            // Couldn't even produce a thumbnail - something's wrong with
            // this frame. Fail closed: treat as a positive rather than
            // silently dropping it, per the module's own "uncertain/error
            // -> positive" policy at the classification stage. A frame we
            // can't even downscale is at least as uncertain as one the
            // classifier fails on.
            reportUncertainAsPositive(displayID: displayID)
            return
        }

        let hash = perceptualHash(of: thumbnail)
        if let lastHash = lastFrameHash[displayID], hammingDistance(hash, lastHash) < 4 {
            // Materially unchanged since last frame - skip the rest of the
            // pipeline entirely. This is a pure performance optimization,
            // not a safety-relevant decision, so no fail-open/fail-closed
            // concern here: if the frame didn't change, whatever
            // conclusion applied last time still applies.
            return
        }
        lastFrameHash[displayID] = hash

        let skinRatio = skinPixelRatio(of: thumbnail)
        // TEMPORARY diagnostic logging (Phase 2 detection testing) - remove
        // once the pipeline is confirmed working end-to-end against real
        // content. Logs every frame that reaches this point, whether or
        // not it clears the prefilter, so a false negative can be
        // distinguished between "never reached the classifier" and "the
        // classifier scored it too low."
        NSLog("ContentGuardAgent: [debug] skinRatio=\(skinRatio) threshold=\(skinRatioPrefilterThreshold)")
        guard skinRatio >= skinRatioPrefilterThreshold else {
            // Below threshold -> skip the full classifier. This IS a load
            // shedder, not an acquitter: the threshold is deliberately
            // permissive specifically so this never becomes the thing that
            // "cleared" a frame that should have been blocked - it only
            // ever skips frames confidently unlikely to contain the target
            // classes at all.
            return
        }

        guard let scaledForModel = downscale(pixelBuffer, targetDimension: 640) else {
            reportUncertainAsPositive(displayID: displayID)
            return
        }

        do {
            let result = try classifier.classify(scaledForModel)
            switch result {
            case .clean:
                NSLog("ContentGuardAgent: [debug] classify() -> .clean")
            case .detected(let detectionClass, let confidence, _):
                NSLog("ContentGuardAgent: [debug] classify() -> .detected class=\(detectionClass) confidence=\(confidence)")
                guard confidence >= ContentGuardConfig.detectionConfidenceThreshold else {
                    // Below the confirmation gate - a single borderline
                    // frame shouldn't cost 10 minutes, per the original
                    // spec. This is the ONE place in the pipeline where
                    // "uncertain" resolves toward NOT blacking out, and
                    // it's deliberate: everywhere else, uncertainty fails
                    // closed; here specifically, sub-threshold confidence
                    // is treated as "not confirmed" by design, not as an
                    // error case.
                    return
                }
                report(detectionClass: detectionClass, confidence: confidence, displayID: displayID)
            }
        } catch {
            NSLog("ContentGuardAgent: [debug] classify() threw \(error) - failing closed")
            // Classifier itself errored (model load issue, inference
            // failure, etc) - this IS an error case, and per the spec,
            // errors fail closed.
            reportUncertainAsPositive(displayID: displayID)
        }
    }

    private func report(detectionClass: String, confidence: Float, displayID: CGDirectDisplayID) {
        let detection = BlackoutData(confidence: confidence, detectionClass: detectionClass, timestamp: Date().timeIntervalSince1970)
        delegate?.frameProcessor(self, didDetect: detection, on: displayID)
    }

    private func reportUncertainAsPositive(displayID: CGDirectDisplayID) {
        let detection = BlackoutData(confidence: 1.0, detectionClass: "UNCERTAIN_FAIL_CLOSED", timestamp: Date().timeIntervalSince1970)
        delegate?.frameProcessor(self, didDetect: detection, on: displayID)
    }

    // MARK: - Downscaling

    /// GPU-backed downscale via CoreImage (CIContext defaults to a Metal-
    /// backed render, not CPU, on Apple Silicon).
    private func downscale(_ pixelBuffer: CVPixelBuffer, targetDimension: Int) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else { return nil }

        let scale = CGFloat(targetDimension) / CGFloat(max(width, height))
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        var output: CVPixelBuffer?
        let outWidth = max(1, Int(CGFloat(width) * scale))
        let outHeight = max(1, Int(CGFloat(height) * scale))
        CVPixelBufferCreate(kCFAllocatorDefault, outWidth, outHeight, kCVPixelFormatType_32BGRA, nil, &output)
        guard let output else { return nil }

        ciContext.render(ciImage, to: output)
        return output
    }

    // MARK: - Perceptual hash (for the change-debounce check)

    /// A simple average-hash: not cryptographic, not meant to be - just
    /// needs to be cheap and stable enough that "same-ish frame" hashes
    /// close together and "different frame" hashes far apart.
    private func perceptualHash(of pixelBuffer: CVPixelBuffer) -> UInt64 {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return 0 }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let buffer = base.assumingMemoryBound(to: UInt8.self)

        // Sample an 8x8 grid of average-brightness bits - cheap and good
        // enough for "did this change materially."
        var luminances: [UInt8] = []
        for gy in 0..<8 {
            for gx in 0..<8 {
                let x = min(width - 1, gx * width / 8)
                let y = min(height - 1, gy * height / 8)
                let offset = y * bytesPerRow + x * 4 // BGRA
                let b = buffer[offset], g = buffer[offset + 1], r = buffer[offset + 2]
                // Split into separate typed sub-expressions - the one-liner
                // version of this (all three Int(...) conversions,
                // multiplications, and the division in one expression) is
                // valid Swift but hits a real compiler limitation: the
                // type-checker gives up on it as too expensive to resolve,
                // rather than getting the arithmetic wrong.
                let rWeighted = Int(r) * 299
                let gWeighted = Int(g) * 587
                let bWeighted = Int(b) * 114
                let luminance = UInt8((rWeighted + gWeighted + bWeighted) / 1000)
                luminances.append(luminance)
            }
        }
        let average = luminances.reduce(0) { $0 + Int($1) } / max(1, luminances.count)
        var hash: UInt64 = 0
        for (index, luminance) in luminances.enumerated() {
            if Int(luminance) >= average {
                hash |= (1 << UInt64(index))
            }
        }
        return hash
    }

    private func hammingDistance(_ a: UInt64, _ b: UInt64) -> Int {
        (a ^ b).nonzeroBitCount
    }

    // MARK: - Skin-tone prefilter

    /// Cheap YCbCr-range skin heuristic over the same thumbnail used for
    /// the change hash - deliberately crude (a fixed Cb/Cr band), since its
    /// only job is deciding whether to bother with a full inference, not
    /// deciding anything final. See the class doc comment.
    private func skinPixelRatio(of pixelBuffer: CVPixelBuffer) -> Double {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return 1.0 } // can't evaluate -> don't shed
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let buffer = base.assumingMemoryBound(to: UInt8.self)

        var skinCount = 0
        var totalCount = 0
        for y in stride(from: 0, to: height, by: 1) {
            for x in stride(from: 0, to: width, by: 1) {
                let offset = y * bytesPerRow + x * 4 // BGRA
                let b = Double(buffer[offset])
                let g = Double(buffer[offset + 1])
                let r = Double(buffer[offset + 2])

                let cb = -0.169 * r - 0.331 * g + 0.500 * b + 128
                let cr = 0.500 * r - 0.419 * g - 0.081 * b + 128

                totalCount += 1
                if cb >= 77, cb <= 127, cr >= 133, cr <= 173 {
                    skinCount += 1
                }
            }
        }
        guard totalCount > 0 else { return 1.0 }
        return Double(skinCount) / Double(totalCount)
    }
}
