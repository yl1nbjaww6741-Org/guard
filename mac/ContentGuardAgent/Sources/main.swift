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

    /// A frame ScreenCaptureKit reported as carrying no new content still
    /// has to bump framesProcessed, exactly like a fully processed one.
    ///
    /// This is load-bearing, not bookkeeping: the daemon's frame-stall
    /// detection (HeartbeatMonitor, ContentGuardConfig.frameStallGraceSeconds)
    /// treats a frozen framesProcessed count as a silently dead capture
    /// stream and fails closed by sleeping the display. Skipping unchanged
    /// frames without reporting them here would freeze that counter during
    /// any genuinely static screen - reading a long page without touching
    /// the trackpad is enough - and the daemon would put the display to
    /// sleep every 30 seconds on a completely healthy agent.
    ///
    /// The counter's real meaning is "the capture pipeline is alive and
    /// keeping up", which an unchanged frame proves just as well as a
    /// processed one. It was never a count of classifier inferences - the
    /// skin prefilter has always skipped most frames well before that point.
    func captureManagerDidSkipUnchangedFrame(_ manager: CaptureManager) {
        heartbeatClient.recordFrameProcessed()
    }

    /// See CaptureManager.handleScreensSleep()'s doc comment.
    /// captureActive going false here is load-bearing, not cosmetic: it's
    /// what keeps HeartbeatMonitor.checkGraceWindow() on the daemon side
    /// from reading this intentional pause as the exact dead-stream
    /// signature ContentGuardConfig.frameStallGraceSeconds exists to catch
    /// (frozen framesProcessed + captureActive still claiming true). With
    /// this honestly reporting false instead, that check's own
    /// `captureActive == true` gate excludes the pause entirely - no
    /// false "failing closed" against a display that's already off.
    func captureManagerDidPauseForDisplaySleep(_ manager: CaptureManager) {
        NSLog("ContentGuardAgent: capture paused for display sleep")
        heartbeatClient.captureActive = false
    }

    func captureManagerDidResumeFromDisplaySleep(_ manager: CaptureManager) {
        NSLog("ContentGuardAgent: capture resumed after display wake")
        heartbeatClient.captureActive = true
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
    // weaker than the blackout+cooldown approach - no forced waiting period
    // on the very first detection, unlike BlackoutTimer's immediate
    // 10-minute cover. Partially closed, not fully: quitFrontmostApp() below
    // also reports every detection-triggered quit to the daemon
    // (heartbeatClient.sendAppDetection), and AppLockManager.swift locks the
    // specific app out from relaunching for 10 minutes once it's been quit
    // this way appBlockCountThreshold times - so a *single* detection still
    // just gets a quiet quit-and-reopen, but repeatedly triggering on the
    // same app stops working after a few tries. The daemon's separate
    // tamper-resistance (heartbeat monitoring, fail-closed on the agent
    // going quiet, escalation on repeated agent kills) is UNCHANGED and
    // still fully active - that protects against someone killing the agent
    // process itself, a different concern from "what happens right after a
    // detection."
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
            // Captured BEFORE forceTerminate() below, deliberately - found
            // the hard way on the real Mac that reading executableURL
            // AFTER telling NSRunningApplication to terminate silently
            // failed to report every single detection to the daemon
            // (AppLockManager never saw a single appDetection message
            // despite 5 real force-quits in one test run). bundleID was
            // already safe (read earlier, in the guard above) - this pulls
            // executablePath into the same "read metadata from a still-
            // alive process" window, rather than querying a process that's
            // already been told to die. Uses executableURL, not bundleURL:
            // the daemon's enforcement matches against what a *running*
            // process's path actually looks like (proc_pidpath() ->
            // .../Contents/MacOS/AppName), not the bundle directory.
            let executablePath = frontmost.executableURL?.path

            NSLog("ContentGuardAgent: force-terminating \(bundleID)")
            // forceTerminate(), not terminate() - a normal quit request can
            // be intercepted by the app itself (an "unsaved changes?"
            // dialog would leave the content on screen exactly as long as
            // that dialog sits unanswered). This needs to be unconditional.
            frontmost.forceTerminate()

            // Report this to the daemon so repeated detections on the same
            // app can trigger a real lockout (AppLockManager.swift), not
            // just a one-off quit each time - closing the tradeoff this
            // whole reaction's own doc comment calls out above.
            if let executablePath {
                // Explicit self required here (unlike captureManager/
                // heartbeatClient references elsewhere in this file) -
                // real compiler error, not a style choice: this project
                // sets default-isolation=MainActor, and the first time a
                // closure passed to a non-isolated API like
                // DispatchQueue.main.async actually touches an instance
                // member (this line is the first one in this specific
                // closure that does - NSWorkspace.shared/ContentGuardConfig/
                // frontmost above aren't self members), the compiler needs
                // capture semantics made explicit rather than inferring
                // them silently.
                self.heartbeatClient.sendAppDetection(bundleID: bundleID, executablePath: executablePath)
            } else {
                NSLog("ContentGuardAgent: no executableURL for \(bundleID) - can't report it for app-lock tracking")
            }
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
