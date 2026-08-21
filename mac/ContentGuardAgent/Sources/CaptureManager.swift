// One SCStream per display, delivering frames to FrameProcessor at a fixed
// 3-second interval. Owns the display-hotplug and sleep/wake lifecycle -
// SCStream dies on sleep and needs rebuilding on wake, per Apple's own
// documented behavior, not a bug in this code.

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
    }

    func stop() async {
        for (_, stream) in streams {
            try? await stream.stopCapture()
        }
        streams.removeAll()
    }

    // MARK: - Stream (re)building

    private func rebuildAllStreams() async throws {
        await stop()

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let ownWindowNumbers = overlayManager.ownWindowNumbers
        let ownWindows = content.windows.filter { ownWindowNumbers.contains(Int($0.windowID)) }

        for display in content.displays {
            try await buildStream(for: display, ownOverlayWindows: ownWindows)
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
