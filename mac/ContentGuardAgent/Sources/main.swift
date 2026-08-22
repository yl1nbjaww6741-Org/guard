// ContentGuardAgent entry point. Runs as the logged-in user via
// LaunchAgents/com.contentguard.agent.plist. Needs a real AppKit run loop
// (NSApplication, not a bare RunLoop like the daemon) since NSPanel and the
// NSWorkspace notifications CaptureManager/AppScopeManager depend on both
// need one. LSUIElement = true in Info.plist keeps it out of the Dock and
// app switcher - it's a background agent, not something the user interacts
// with directly.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let overlayManager = OverlayManager()
    private let appScopeManager = AppScopeManager()
    private lazy var captureManager = CaptureManager(appScopeManager: appScopeManager, overlayManager: overlayManager)
    private var frameProcessor: FrameProcessor?
    private let heartbeatClient = HeartbeatClient()

    func applicationDidFinishLaunching(_ notification: Notification) {
        captureManager.delegate = self

        do {
            let classifier = try NudeNetClassifier()
            heartbeatClient.modelHash = classifier.modelHash
            let processor = FrameProcessor(classifier: classifier)
            processor.delegate = self
            frameProcessor = processor
        } catch {
            // No usable classifier - this is exactly the "uncertain/error"
            // case the whole design fails closed on. Cover every display
            // immediately and stay covered, rather than starting up in a
            // state where frames are captured but never actually evaluated.
            NSLog("ContentGuardAgent: classifier failed to load (\(error)) - failing closed")
            overlayManager.cover()
        }

        heartbeatClient.start()

        Task {
            do {
                try await captureManager.start()
                heartbeatClient.captureActive = true
            } catch {
                NSLog("ContentGuardAgent: capture failed to start (\(error)) - failing closed")
                heartbeatClient.captureActive = false
                overlayManager.cover()
            }
        }
    }
}

extension AppDelegate: CaptureManagerDelegate {
    func captureManager(_ manager: CaptureManager, didCapture pixelBuffer: CVPixelBuffer, on displayID: CGDirectDisplayID) {
        guard let frameProcessor else {
            // No classifier loaded - already covering from
            // applicationDidFinishLaunching's failure path, nothing more to
            // do per-frame.
            return
        }
        frameProcessor.process(pixelBuffer: pixelBuffer, displayID: displayID)
    }
}

extension AppDelegate: FrameProcessorDelegate {
    func frameProcessor(_ processor: FrameProcessor, didDetect detection: BlackoutData, on displayID: CGDirectDisplayID) {
        NSLog("ContentGuardAgent: BLACKOUT triggered - class=\(detection.detectionClass) confidence=\(detection.confidence) display=\(displayID)")
        overlayManager.cover()
        heartbeatClient.sendBlackout(detection)
    }

    func frameProcessorDidProcessFrame(_ processor: FrameProcessor) {
        heartbeatClient.recordFrameProcessed()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Redundant with Info.plist's LSUIElement, set here too so it holds even if
// the app is ever launched in a context that doesn't read the bundle's
// Info.plist correctly (e.g. certain debugging/launch paths during
// development) - belt and suspenders on "don't show a Dock icon."
app.setActivationPolicy(.accessory)
app.run()
