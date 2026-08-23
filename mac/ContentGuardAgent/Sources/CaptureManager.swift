// One SCStream per display, delivering frames to FrameProcessor at a fixed
// 3-second interval. Owns the display-hotplug and sleep/wake lifecycle -
// SCStream dies on sleep and needs rebuilding on wake, per Apple's own
// documented behavior, not a bug in this code. Also self-heals a silently
// dead stream that no OS notification ever fires for - see
// startStreamHealthCheck()'s doc comment.

import AppKit
import ScreenCaptureKit

protocol CaptureManagerDelegate: AnyObject {
    func captureManager(_ manager: CaptureManager, didCapture pixelBuffer: CVPixelBuffer, on displayID: CGDirectDisplayID)
}

final class CaptureManager: NSObject {
    weak var delegate: CaptureManagerDelegate?

    private let appScopeManager: AppScopeManager
    private let overlayManager: OverlayManager
    private var streams: [CGDirectDisplayID: SCStream] = [:]
    private let outputQueue = DispatchQueue(label: "com.contentguard.agent.capture-output")

    /// Set every time a real frame is delivered, and reset to "now" whenever
    /// streams are (re)built - see startStreamHealthCheck()'s doc comment
    /// for why this exists. Only ever touched from outputQueue - the same
    /// queue didOutputSampleBuffer and the health-check timer both run on -
    /// so no additional locking is needed.
    private var lastFrameDeliveredAt: Date?
    private var streamHealthTimer: DispatchSourceTimer?
    private var isRebuilding = false

    init(appScopeManager: AppScopeManager, overlayManager: OverlayManager) {
        self.appScopeManager = appScopeManager
        self.overlayManager = overlayManager
        super.init()
        appScopeManager.delegate = self

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWake),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleDisplayChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func start() async throws {
        try await appScopeManager.refresh()
        try await rebuildAllStreams()
        startStreamHealthCheck()
    }

    func stop() async {
        for (_, stream) in streams {
            try? await stream.stopCapture()
        }
        streams.removeAll()
    }

    // MARK: - Stream (re)building

    private func rebuildAllStreams() async throws {
        // Guards against overlapping rebuilds - real possibility now that
        // there are multiple independent triggers (OS notifications, the
        // self-heal timer below) that can each fire a rebuild around the
        // same time. Not a hard lock, just cheap insurance against a
        // pointless rebuild storm; worst case without it is a redundant
        // extra rebuild, not a crash.
        guard !isRebuilding else { return }
        isRebuilding = true
        defer { isRebuilding = false }

        await stop()

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let ownWindowNumbers = overlayManager.ownWindowNumbers
        let ownWindows = content.windows.filter { ownWindowNumbers.contains(Int($0.windowID)) }

        for display in content.displays {
            try await buildStream(for: display, ownOverlayWindows: ownWindows)
        }

        // Reset the health-check baseline to "now" - a freshly (re)built
        // stream hasn't had a chance to deliver its first frame yet, and
        // shouldn't be judged against whatever stale timestamp (or none at
        // all) preceded this rebuild.
        outputQueue.async { [weak self] in
            self?.lastFrameDeliveredAt = Date()
        }
    }

    private func buildStream(for display: SCDisplay, ownOverlayWindows: [SCWindow]) async throws {
        let excludedWindows = appScopeManager.safeAppWindows() + ownOverlayWindows
        let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)

        let config = SCStreamConfiguration()
        // 0.33 fps, matching ContentGuardConfig.captureIntervalSeconds - a
        // fixed cadence, not something to tune per-device (see
        // mac/README.md's key decisions).
        config.minimumFrameInterval = CMTime(
            seconds: ContentGuardConfig.captureIntervalSeconds,
            preferredTimescale: 600
        )
        config.showsCursor = false
        config.width = display.width
        config.height = display.height

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
        try await stream.startCapture()
        streams[display.displayID] = stream
    }

    // MARK: - Self-healing stream health check

    /// Found necessary on the real Mac: a silently dead SCStream (this
    /// module's own doc comment already covers the documented sleep/wake
    /// case, but a stream can also just die outside of any OS notification
    /// at all - confirmed live more than once this session) can otherwise
    /// persist indefinitely with nothing to actually fix it. The daemon's
    /// own frame-stall detection (HeartbeatMonitor.swift,
    /// ContentGuardConfig.frameStallGraceSeconds) can NOTICE this - real
    /// heartbeats arriving with a frozen frame count - but its only lever
    /// is FallbackCover's pmset displaysleepnow, reissued every grace-check
    /// tick for as long as the stall persists. That's a real fail-closed
    /// response, but it does nothing to fix the underlying dead stream -
    /// confirmed live: a stall that started once just stayed stalled,
    /// repeatedly sleeping the display, until a human ran
    /// `launchctl kickstart` by hand. This closes the gap at the source -
    /// the agent watching its own pipeline and rebuilding proactively,
    /// rather than relying on a human noticing or a real system sleep/wake
    /// cycle happening to fix it as a side effect.
    ///
    /// Deliberately shorter than the daemon's own frameStallGraceSeconds
    /// (30s) - this should resolve a stall well before the daemon's more
    /// disruptive fail-closed response ever needs to fire at all, not race
    /// it.
    private func startStreamHealthCheck() {
        let t = DispatchSource.makeTimerSource(queue: outputQueue)
        t.schedule(
            deadline: .now() + ContentGuardConfig.captureStreamStallGraceSeconds,
            repeating: ContentGuardConfig.captureStreamStallGraceSeconds
        )
        t.setEventHandler { [weak self] in
            self?.checkStreamHealth()
        }
        t.resume()
        streamHealthTimer = t
    }

    private func checkStreamHealth() {
        // Nothing built yet (start() hasn't run, or we're mid-teardown) -
        // nothing to judge as stalled.
        guard !streams.isEmpty else { return }

        let reference = lastFrameDeliveredAt ?? .distantPast
        guard Date().timeIntervalSince(reference) > ContentGuardConfig.captureStreamStallGraceSeconds else { return }

        NSLog("ContentGuardAgent: no frame delivered in over \(Int(ContentGuardConfig.captureStreamStallGraceSeconds))s - stream looks dead, rebuilding")
        Task {
            try? await rebuildAllStreams()
        }
    }

    // MARK: - Lifecycle events

    @objc private func handleWake() {
        Task {
            // SCStream connections don't survive sleep - rebuilding from
            // scratch rather than trying to detect and repair a half-dead
            // stream, which is more failure-prone than a clean rebuild.
            try? await rebuildAllStreams()
        }
    }

    @objc private func handleDisplayChange() {
        Task {
            try? await rebuildAllStreams()
        }
    }
}

extension CaptureManager: AppScopeManagerDelegate {
    func appScopeManagerDidUpdateScope(_ manager: AppScopeManager) {
        Task {
            // A safe app launched or quit - the exclusion list changed, and
            // SCContentFilter is immutable once built, so this means a
            // rebuild, not an in-place update.
            try? await rebuildAllStreams()
        }
    }
}

extension CaptureManager: SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        guard let pixelBuffer = sampleBuffer.imageBuffer else { return }

        let displayID = streams.first(where: { $0.value === stream })?.key
        guard let displayID else { return }

        lastFrameDeliveredAt = Date()
        delegate?.captureManager(self, didCapture: pixelBuffer, on: displayID)
    }
}

extension CaptureManager: SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // A stream can die outside of sleep/wake too (e.g. the display
        // disconnects mid-capture) - treat any unexpected stop the same way
        // as a display-change event, since "rebuild everything from a fresh
        // SCShareableContent snapshot" is correct either way.
        Task {
            try? await rebuildAllStreams()
        }
    }
}
