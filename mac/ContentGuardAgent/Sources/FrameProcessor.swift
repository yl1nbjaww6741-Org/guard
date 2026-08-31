// Per-frame pipeline: skip frames that haven't materially changed, downscale
// for the classifier, cheaply prefilter on skin-tone ratio before spending a
// full NudeNet inference, then classify. Two different "when in doubt"
// policies apply at two different stages, deliberately not the same policy -
// see the comments on each.

import CoreImage
import CoreVideo
import Foundation

protocol FrameProcessorDelegate: AnyObject {
    func frameProcessor(_ processor: FrameProcessor, didDetect detection: BlackoutData, from source: CaptureSource)
    func frameProcessorDidProcessFrame(_ processor: FrameProcessor)
}

final class FrameProcessor {
    weak var delegate: FrameProcessorDelegate?

    private let classifier: NudeNetClassifier
    private let ciContext = CIContext()
    /// Keyed on CaptureSource, not just a display - a dedicated per-window
    /// risky-app stream (see CaptureManager.riskyWindowStreams) needs its
    /// own independent change-hash state exactly like a display does, so
    /// this generalizes to whichever capture pipeline the frame came from
    /// rather than needing two separate dictionaries.
    private var lastFrameHash: [CaptureSource: UInt64] = [:]
    private let processingQueue = DispatchQueue(label: "com.contentguard.agent.frame-processing", qos: .utility)

    /// Skin-tone prefilter threshold - deliberately permissive, but no
    /// longer a guess: found the hard way on the real Mac that the
    /// original 0.05 barely cleared normal desktop "skin tone noise" at
    /// all - Activity Monitor showed ContentGuardAgent as the single
    /// highest Energy Impact process running (126.8, above Chrome, above
    /// everything), and the agent's own debug log during completely
    /// ordinary use (no NSFW content anywhere) showed skinRatio
    /// consistently landing at ~0.066-0.069 - just barely above 0.05 - so
    /// the "load shedder" was shedding almost nothing: 36 of the last 42
    /// captured frames were reaching a full ONNX Runtime + CoreML
    /// inference, continuously, every ~3s, for no reason. Cross-checked
    /// against every confirmed real detection from this session's testing:
    /// every one of them needed a skin ratio of 0.2+ before the classifier
    /// produced anything but a ~1e-5 near-zero confidence - below that,
    /// confidence stayed firmly negligible regardless of skin ratio. 0.15
    /// sits with real margin on both sides of that real data: well above
    /// the observed normal-use noise floor (~0.05-0.09), well below the
    /// observed real-content floor (0.2+) - still a load shedder, not an
    /// acquitter (see the module doc comment), just one actually doing its
    /// job now instead of passing nearly everything through.
    private let skinRatioPrefilterThreshold: Double = 0.15

    /// Second prefilter path, added alongside the whole-frame threshold
    /// above after a real, confirmed miss: genuinely explicit Reddit
    /// images, embedded in a page with a lot of surrounding chrome
    /// (sidebar, header, whitespace), never reached the classifier at all
    /// - live debug logging showed skinRatio sitting at 0.005-0.12 for
    /// those exact frames, comfortably under 0.15, because the whole-frame
    /// average dilutes a real image's skin coverage by however much of the
    /// screen isn't that image. A single global average genuinely cannot
    /// distinguish "explicit image occupying a third of the screen" from
    /// "normal desktop skin-tone noise" - this session's own data put both
    /// in the same 0.05-0.12 band. So this checks the densest single
    /// region instead of the whole-frame mean: real explicit content forms
    /// a concentrated blob of skin pixels; diffuse desktop noise (wood
    /// grain, a face in a video call thumbnail, warm lighting) doesn't
    /// cluster like that even at a similar whole-frame average. 0.35 was
    /// first confirmed against the two real detections that motivated this
    /// fix (maxBlockRatio 0.7 and 0.9, both well above 0.35) against
    /// ordinary browsing that topped out around 0.2 - but that used an 8x8
    /// block grid, since replaced by a 4x4 grid (see skinAnalysis's doc
    /// comment) specifically because 8x8 blocks were small enough for a
    /// single static icon to saturate one on its own. The 0.35 threshold
    /// itself carries over unchanged - it's a ratio, not tied to a
    /// specific grid size - but its real-data confirmation was against the
    /// old grid, so it's provisional again against the new one until
    /// re-confirmed the same way.
    private let skinRatioPrefilterBlockThreshold: Double = 0.35

    init(classifier: NudeNetClassifier) {
        self.classifier = classifier
    }

    func process(pixelBuffer: CVPixelBuffer, source: CaptureSource) {
        processingQueue.async { [weak self] in
            self?.processOnQueue(pixelBuffer: pixelBuffer, source: source)
        }
    }

    private func processOnQueue(pixelBuffer: CVPixelBuffer, source: CaptureSource) {
        defer { delegate?.frameProcessorDidProcessFrame(self) }

        let thumbnail = downscale(pixelBuffer, targetDimension: 64)
        guard let thumbnail else {
            // Couldn't even produce a thumbnail - something's wrong with
            // this frame. Fail closed: treat as a positive rather than
            // silently dropping it, per the module's own "uncertain/error
            // -> positive" policy at the classification stage. A frame we
            // can't even downscale is at least as uncertain as one the
            // classifier fails on.
            reportUncertainAsPositive(source: source)
            return
        }

        let hash = perceptualHash(of: thumbnail)
        if let lastHash = lastFrameHash[source], hammingDistance(hash, lastHash) < 4 {
            // Materially unchanged since last frame - skip the rest of the
            // pipeline entirely. This is a pure performance optimization,
            // not a safety-relevant decision, so no fail-open/fail-closed
            // concern here: if the frame didn't change, whatever
            // conclusion applied last time still applies.
            return
        }
        lastFrameHash[source] = hash

        let (skinRatio, maxBlockSkinRatio) = skinAnalysis(of: thumbnail)
        // No per-frame logging here, deliberately. The 4x4-grid fix this
        // file's skinAnalysis doc comment describes was confirmed against
        // real data, so the TEMPORARY debug NSLog that confirmed it is
        // gone - it ran unconditionally on every captured frame, on every
        // display, indefinitely, and per-frame logging has already been
        // removed once before for exactly that reason (see this file's
        // git history: "perf: fix prefilter barely shedding any load,
        // remove per-frame debug logging"). If a future diagnostic pass
        // needs it back, re-add it TEMPORARY the same way - and remove it
        // again once it has served its purpose.
        guard skinRatio >= skinRatioPrefilterThreshold || maxBlockSkinRatio >= skinRatioPrefilterBlockThreshold else {
            // Below both thresholds -> skip the full classifier. Still a
            // load shedder, not an acquitter, on both paths: each
            // threshold is deliberately permissive on its own axis (whole-
            // frame average / densest local region) specifically so
            // neither becomes the thing that "cleared" a frame that should
            // have been blocked - together they only skip frames
            // confidently unlikely to contain the target classes at all,
            // whether the skin coverage is diffuse or concentrated.
            return
        }

        // NudeNetClassifier.preprocess() requires both dimensions <= 640
        // (the 640m model's fixed input canvas) and letterboxes whatever it
        // gets into the top-left of that canvas, so a frame already within
        // budget can go straight through untouched. Since CaptureManager
        // now asks SCStream for at most
        // ContentGuardConfig.maxCaptureDimension on the longer side, that
        // is the normal path - and the downscale() call it replaces was a
        // full CoreImage render pass that, at a 1:1 scale factor, produced
        // a pixel-identical copy of its input for nothing.
        //
        // The downscale fallback stays for the cases where a frame can
        // still arrive oversized: a display smaller than the cap is
        // captured at its own size (fine, still under), but a rebuild races
        // a resolution change, or maxCaptureDimension is ever raised above
        // the model's 640, and this must not hand the classifier something
        // it will reject. Checked against the real buffer's dimensions
        // rather than assuming the configured size took effect.
        let modelInputDimension = 640
        let frameWidth = CVPixelBufferGetWidth(pixelBuffer)
        let frameHeight = CVPixelBufferGetHeight(pixelBuffer)
        let scaledForModel: CVPixelBuffer?
        if frameWidth > 0, frameHeight > 0,
           frameWidth <= modelInputDimension, frameHeight <= modelInputDimension {
            scaledForModel = pixelBuffer
        } else {
            scaledForModel = downscale(pixelBuffer, targetDimension: modelInputDimension)
        }
        guard let scaledForModel else {
            reportUncertainAsPositive(source: source)
            return
        }

        do {
            let result = try classifier.classify(scaledForModel)
            switch result {
            case .clean:
                break
            case .detected(let detectionClass, let confidence, _):
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
                report(detectionClass: detectionClass, confidence: confidence, source: source)
            }
        } catch {
            NSLog("ContentGuardAgent: classify() threw \(error) - failing closed")
            // Classifier itself errored (model load issue, inference
            // failure, etc) - this IS an error case, and per the spec,
            // errors fail closed. Real, rare, operationally meaningful -
            // unlike the per-frame [debug] logging removed above (see this
            // file's git history for that - it served its purpose
            // confirming the pipeline end-to-end against real content
            // across this session's testing, and was itself a real,
            // measured cost: it ran unconditionally on every single
            // captured frame, indefinitely, for as long as the agent runs).
            reportUncertainAsPositive(source: source)
        }
    }

    private func report(detectionClass: String, confidence: Float, source: CaptureSource) {
        let detection = BlackoutData(confidence: confidence, detectionClass: detectionClass, timestamp: Date().timeIntervalSince1970)
        delegate?.frameProcessor(self, didDetect: detection, from: source)
    }

    private func reportUncertainAsPositive(source: CaptureSource) {
        let detection = BlackoutData(confidence: 1.0, detectionClass: "UNCERTAIN_FAIL_CLOSED", timestamp: Date().timeIntervalSince1970)
        delegate?.frameProcessor(self, didDetect: detection, from: source)
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
    ///
    /// Computes both prefilter signals in one pass over the pixels (rather
    /// than two separate scans) since both need the same per-pixel skin
    /// classification: `globalRatio` is skin pixels as a fraction of the
    /// whole thumbnail (the original heuristic), `maxBlockRatio` is the
    /// highest skin ratio found in any single cell of a grid over that
    /// same thumbnail (added after a real miss - see
    /// skinRatioPrefilterBlockThreshold's doc comment).
    ///
    /// Grid is 4x4, not 8x8 - originally matched perceptualHash's sampling
    /// grid "for convenience" (see this file's git history), never
    /// validated for this purpose, and real data caught the consequence:
    /// on a 64px-wide thumbnail an 8x8 cell is only ~8x8 pixels, small
    /// enough for one static desktop icon or avatar to fill on its own and
    /// peg maxBlockRatio near 1.0 every tick regardless of actual content
    /// (confirmed live - a fixed 0.55 recurred repeatedly while skinRatio
    /// sat at the normal ~0.05 noise floor, i.e. nothing resembling real
    /// content was even on screen). A 4x4 cell is 4x the area - the same
    /// small icon now contributes at most ~1/4 of a cell's pixels, pulling
    /// its ratio back under threshold, while a real embedded image (which
    /// was always large enough to span multiple 8x8 cells already, e.g.
    /// the confirmed real detections at 0.7/0.9) stays concentrated enough
    /// to saturate a 4x4 cell too.
    private func skinAnalysis(of pixelBuffer: CVPixelBuffer) -> (globalRatio: Double, maxBlockRatio: Double) {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        // Can't evaluate -> don't shed, on both signals.
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return (1.0, 1.0) }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else { return (1.0, 1.0) }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let buffer = base.assumingMemoryBound(to: UInt8.self)

        let gridSize = 4
        var blockSkinCounts = [Int](repeating: 0, count: gridSize * gridSize)
        var blockTotalCounts = [Int](repeating: 0, count: gridSize * gridSize)
        var totalSkinCount = 0
        var totalCount = 0

        for y in 0..<height {
            let blockY = min(gridSize - 1, y * gridSize / height)
            for x in 0..<width {
                let offset = y * bytesPerRow + x * 4 // BGRA
                let b = Double(buffer[offset])
                let g = Double(buffer[offset + 1])
                let r = Double(buffer[offset + 2])

                let cb = -0.169 * r - 0.331 * g + 0.500 * b + 128
                let cr = 0.500 * r - 0.419 * g - 0.081 * b + 128
                let isSkin = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173

                let blockX = min(gridSize - 1, x * gridSize / width)
                let blockIndex = blockY * gridSize + blockX
                blockTotalCounts[blockIndex] += 1
                totalCount += 1
                if isSkin {
                    blockSkinCounts[blockIndex] += 1
                    totalSkinCount += 1
                }
            }
        }

        guard totalCount > 0 else { return (1.0, 1.0) }
        let globalRatio = Double(totalSkinCount) / Double(totalCount)

        var maxBlockRatio = 0.0
        for i in 0..<(gridSize * gridSize) where blockTotalCounts[i] > 0 {
            maxBlockRatio = max(maxBlockRatio, Double(blockSkinCounts[i]) / Double(blockTotalCounts[i]))
        }

        return (globalRatio, maxBlockRatio)
    }
}
