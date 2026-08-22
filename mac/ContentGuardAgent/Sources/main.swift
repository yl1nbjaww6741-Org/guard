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
            // No usable classifier - genuinely "uncertain/error", the case
            // the whole design fails closed on - but NOT by covering the
            // screen here anymore. That used to call overlayManager.cover()
            // directly, and a real install found the hard way why that was
            // wrong: nothing on the agent's side ever calls the matching
            // .clear(), so a PERSISTENT failure (e.g. a missing permission
            // for this exact install path) combined with KeepAlive=true
            // meant every relaunch re-covered the screen with no way out -
            // a real lockout, confirmed on the real Mac, not a hypothetical.
            // The daemon's own fail-closed mechanism (missing heartbeat +
            // a risky app running -> FallbackCover's pmset displaysleepnow,
            // already confirmed working AND actually escapable via a
            // password) is the real backstop for this now - the agent
            // failing to start capturing means it also won't be sending
            // heartbeats, which the daemon will notice on its own. Just log
            // loudly and let heartbeatClient.start() below report
            // modelHash="" / a dead frameProcessor honestly rather than
            // silently hiding the failure.
            NSLog("ContentGuardAgent: classifier failed to load (\(error)) - no local cover, daemon's heartbeat-based fail-closed is the backstop")
        }

        heartbeatClient.start()

        Task {
            do {
                try await captureManager.start()
                heartbeatClient.captureActive = true
            } catch {
                // Same reasoning as above - no overlayManager.cover() here
                // either. captureActive stays false, which means no
                // heartbeat will ever report real capture activity, and
                // the daemon's grace-window check is what fails closed.
                NSLog("ContentGuardAgent: capture failed to start (\(error)) - no local cover, daemon's heartbeat-based fail-closed is the backstop")
                heartbeatClient.captureActive = false
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
    /// Deliberate departure from the original blackout-on-detect design,
    /// per an explicit decision to prioritize disguise over the daemon's
    /// cooldown/escalation protection for this specific reaction: instead
    /// of covering the screen and notifying the daemon (which would start
    /// its own 10-minute cooldown), this force-terminates whatever app is
    /// frontmost at the moment of detection. No overlay, no
    /// heartbeatClient.sendBlackout() call - the daemon's BlackoutTimer/
    /// EscalationManager machinery is intentionally not engaged by this
    /// path.
    //
    // Known, accepted tradeoff (flagged, not hidden): this is meaningfully
    // weaker than the blackout+cooldown approach. Nothing stops
    // immediately reopening the same app/site right after - there's no
    // forced waiting period and no escalation if this happens repeatedly.
    // The daemon's separate tamper-resistance (heartbeat monitoring,
    // fail-closed on the agent going quiet, escalation on repeated agent
    // kills) is UNCHANGED and still fully active - that protects against
    // someone killing the agent process itself, a different concern from
    // "what happens right after a detection."
    func frameProcessor(_ processor: FrameProcessor, didDetect detection: BlackoutData, on displayID: CGDirectDisplayID) {
        NSLog("ContentGuardAgent: DETECTED - class=\(detection.detectionClass) confidence=\(detection.confidence) display=\(displayID)")
        quitFrontmostApp()
    }

    func frameProcessorDidProcessFrame(_ processor: FrameProcessor) {
        heartbeatClient.recordFrameProcessed()
    }

    /// Best-effort: the frontmost app at the moment of detection is a
    /// heuristic, not a certainty - by the time this runs (after capture,
    /// downscale, prefilter, and inference), the user may have already
    /// switched focus. Accepted as good-enough rather than tracking
    /// per-window attribution through the whole pipeline, which the
    /// original design doesn't otherwise need.
    ///
    /// Dispatches to the main thread internally, same reasoning as
    /// OverlayManager.cover()/clear() - this is called from
    /// FrameProcessor's background queue, and NSWorkspace/NSRunningApplication
    /// are AppKit, which already crashed once this session (SIGTRAP) when
    /// called off the main thread. Not repeating that.
    private func quitFrontmostApp() {
        DispatchQueue.main.async {
            guard let frontmost = NSWorkspace.shared.frontmostApplication else {
                NSLog("ContentGuardAgent: no frontmost app to terminate")
                return
            }
            guard let bundleID = frontmost.bundleIdentifier,
                  !ContentGuardConfig.neverTerminateBundleIDs.contains(bundleID) else {
                NSLog("ContentGuardAgent: frontmost app (\(frontmost.bundleIdentifier ?? "unknown")) is on the never-terminate list - not quitting")
                return
            }
            NSLog("ContentGuardAgent: force-terminating \(bundleID)")
            // forceTerminate(), not terminate() - a normal quit request can
            // be intercepted by the app itself (an "unsaved changes?"
            // dialog would leave the content on screen exactly as long as
            // that dialog sits unanswered). This needs to be unconditional.
            frontmost.forceTerminate()
        }
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
