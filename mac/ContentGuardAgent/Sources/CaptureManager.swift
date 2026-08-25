// One SCStream per display, delivering frames to FrameProcessor at
// ContentGuardConfig.captureIntervalSeconds (see that constant's doc
// comment for the current value and why it changed from the original
// 3s). Owns the display-hotplug and sleep/wake lifecycle -
// SCStream dies on sleep and needs rebuilding on wake, per Apple's own
// documented behavior, not a bug in this code. Also self-heals a silently
// dead stream that no OS notification ever fires for - see
// startStreamHealthCheck()'s doc comment.

import AppKit
import CoreVideo
import os
import ScreenCaptureKit

/// Confirmed live on a real Mac that NSLog's output for this process comes
/// back as "(Foundation) <private>" with the message fully redacted, even
/// under `sudo log stream`, regardless of whether the specific message had
/// any dynamic interpolation - a real capture-pause test looked like a
/// no-op in the log for this reason alone, even though the feature itself
/// (confirmed separately, functionally) was working the whole time.
/// os.Logger with explicit `privacy: .public` is what the pause/resume
/// lines below use instead, since confirming those actually fire in the
/// log is the whole point of them existing.
private let logger = Logger(subsystem: "com.contentguard.agent", category: "CaptureManager")

protocol CaptureManagerDelegate: AnyObject {
    func captureManager(_ manager: CaptureManager, didCapture pixelBuffer: CVPixelBuffer, on displayID: CGDirectDisplayID)

    /// Called INSTEAD of didCapture when ScreenCaptureKit delivered a frame
    /// carrying no new content (see frameStatus(of:)). The frame is not
    /// worth processing, but its arrival still proves the capture pipeline
    /// is alive - and that liveness has to reach the heartbeat, or the
    /// daemon reads a healthy agent as stalled. See the implementation in
    /// main.swift for the real failure mode this exists to prevent.
    func captureManagerDidSkipUnchangedFrame(_ manager: CaptureManager)

    /// Called when CaptureManager has stopped its streams for ANY reason -
    /// every display asleep (handleScreensSleep()) or nothing unwhitelisted
    /// currently running (appScopeManagerAllRunningAppsAreSafe()). Two
    /// independent pause sources, one delegate signal - see isPaused's own
    /// doc comment for why this fires on the aggregate transition, not
    /// per-source. The delegate must stop reporting captureActive=true for
    /// the duration (main.swift sets heartbeatClient.captureActive = false),
    /// the same way the capture-failed-to-start path already does - a
    /// legitimate pause looks identical to a dead stream from the daemon's
    /// side (framesProcessed frozen) unless captureActive says otherwise.
    func captureManagerDidPause(_ manager: CaptureManager)

    /// Called once capture has resumed after every active pause source has
    /// cleared and streams were rebuilt.
    func captureManagerDidResume(_ manager: CaptureManager)
}

final class CaptureManager: NSObject {
    weak var delegate: CaptureManagerDelegate?

    private let appScopeManager: AppScopeManager
    private let overlayManager: OverlayManager
    private var streams: [CGDirectDisplayID: SCStream] = [:]
    /// Explicitly .utility, matching FrameProcessor's own processing queue
    /// (which always had it - this one was simply missed). Left unspecified,
    /// a dispatch queue can inherit the priority of whatever enqueues onto
    /// it, which on Apple Silicon is the difference between this landing on
    /// efficiency cores and it landing on performance cores. Nothing here is
    /// latency-critical: frames arrive on a fixed 3-second cadence and the
    /// health check runs every 15 seconds.
    private let outputQueue = DispatchQueue(label: "com.contentguard.agent.capture-output", qos: .utility)

    /// Set every time a real frame is delivered, and reset to "now" whenever
    /// streams are (re)built - see startStreamHealthCheck()'s doc comment
    /// for why this exists. Only ever touched from outputQueue - the same
    /// queue didOutputSampleBuffer and the health-check timer both run on -
    /// so no additional locking is needed.
    private var lastFrameDeliveredAt: Date?
    private var streamHealthTimer: DispatchSourceTimer?
    private var isRebuilding = false

    /// True once start() has run at least once - see checkStreamHealth()'s
    /// doc comment for why this replaced a `!streams.isEmpty` guard. Only
    /// ever touched from outputQueue, same as the other state above.
    private var hasStartedOnce = false

    /// True while capture is intentionally paused because every display is
    /// asleep - see handleScreensSleep()'s doc comment. Exists specifically
    /// to guard checkStreamHealth(): an intentional stop() looks identical
    /// to a real stall from that check's perspective (streams empty,
    /// lastFrameDeliveredAt going stale), and without this the self-heal
    /// timer would rebuild everything within captureStreamStallGraceSeconds
    /// of the display going to sleep - undoing the pause this exists for,
    /// every 25 seconds, for as long as the display stays off.
    private var isPausedForDisplaySleep = false

    /// True while capture is intentionally paused because every currently-
    /// running regular application is on the safe list - see
    /// appScopeManagerAllRunningAppsAreSafe(_:)'s doc comment. Independent
    /// of isPausedForDisplaySleep above: either alone is sufficient reason
    /// to have streams stopped (see isPaused below), and both can be true
    /// at once (e.g. the laptop is locked with only Terminal running) -
    /// each source clears only its own flag on its own wake trigger, and
    /// resuming for real only happens once neither is set.
    private var isPausedForNoRiskyApps = false

    /// The aggregate: true if EITHER pause source is active. This is what
    /// rebuildAllStreams()/checkStreamHealth() actually guard against, and
    /// it's also why captureManagerDidPause/captureManagerDidResume fire on
    /// the aggregate transition rather than once per source - if the
    /// display sleeps first and then the running-app set separately
    /// becomes all-safe while still asleep, that second transition must
    /// NOT re-fire captureManagerDidPause (already paused, nothing new to
    /// report), and clearing the display-sleep flag on wake must NOT fire
    /// captureManagerDidResume while isPausedForNoRiskyApps is still true -
    /// capture is still legitimately not running, and reporting
    /// captureActive=true at that moment would be exactly the kind of
    /// dishonest heartbeat this project has already found and fixed once
    /// (see HeartbeatMonitor.swift's captureJustResumed comment, daemon
    /// side - that fix protects this correctly, but only if this side
    /// never reports captureActive=true while genuinely still paused for
    /// any reason).
    private var isPaused: Bool { isPausedForDisplaySleep || isPausedForNoRiskyApps }

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
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreensSleep),
            name: NSWorkspace.screensDidSleepNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreensWake),
            name: NSWorkspace.screensDidWakeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func start() async throws {
        try await appScopeManager.refresh()
        // Evaluated before the initial rebuildAllStreams() call below,
        // deliberately - if nothing unwhitelisted happens to be running at
        // startup, this sets isPausedForNoRiskyApps synchronously (see
        // appScopeManagerAllRunningAppsAreSafe(_:)) before that call ever
        // runs, so the very first rebuild correctly no-ops via isPaused
        // instead of building streams just to immediately tear them down.
        appScopeManager.evaluateCapturePauseEligibility()
        try await rebuildAllStreams()
        outputQueue.async { [weak self] in
            self?.hasStartedOnce = true
        }
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

        // Guards every rebuild trigger, not just the self-heal timer above -
        // appScopeManagerDidUpdateScope (a safe app launching/quitting),
        // handleDisplayChange, and didStopWithError can all fire while
        // either pause reason is active just as easily as while neither is
        // (none of them require the screen to be lit or a non-safe app
        // running), and none of them know about either pause on their own.
        // Centralizing the check here, rather than guarding each call site
        // individually, means every rebuild path - present and future -
        // respects both pauses automatically. Checked against the
        // aggregate (isPaused), not just isPausedForDisplaySleep, so this
        // correctly stays a no-op if the OTHER pause reason is still
        // active too. Each pause source's own wake handler clears its own
        // flag before calling this, so the one rebuild that's actually
        // supposed to happen (both sources cleared) still does.
        guard !isPaused else { return }

        isRebuilding = true
        defer { isRebuilding = false }

        await stop()

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let ownWindowNumbers = overlayManager.ownWindowNumbers
        let ownWindows = content.windows.filter { ownWindowNumbers.contains(Int($0.windowID)) }

        for display in content.displays {
            try await buildStream(for: display, ownOverlayWindows: ownWindows)
        }

        if streams.isEmpty {
            // Found necessary on the real Mac: SCShareableContent can
            // legitimately return zero displays when this runs during a
            // silent maintenance wake (macOS's periodic brief wake-without-
            // display-on, confirmed live via `pmset -g log` showing
            // mDNSResponder MaintenanceWake entries during an otherwise
            // unexplained multi-hour capture outage) - handleWake() fires
            // NSWorkspace.didWakeNotification for these too, not just a
            // real user-visible wake. Deliberately NOT resetting
            // lastFrameDeliveredAt below in this case - doing so used to
            // tell checkStreamHealth() "fresh and healthy" at the exact
            // moment streams actually went empty, which combined with the
            // old `!streams.isEmpty` guard there meant the health check
            // permanently stopped evaluating staleness from that point on.
            // Confirmed live: capture stayed dead through a real full wake
            // and 3+ minutes of active use afterward, with zero rebuild
            // attempts logged the whole time - this is that gap, closed.
            // Leaving lastFrameDeliveredAt stale (or nil, pre-first-build)
            // means the next checkStreamHealth() tick sees this as overdue
            // and retries, same as any other real stall.
            NSLog("ContentGuardAgent: rebuildAllStreams found 0 displays (likely a silent maintenance wake) - not marking healthy, will retry")
            return
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
        // One frame per ContentGuardConfig.captureIntervalSeconds - stated
        // in terms of the constant rather than a hardcoded fps figure,
        // which went stale the moment the interval changed (see that
        // constant's own doc comment for the 3s -> 5s decision and its
        // rescaled dependents).
        config.minimumFrameInterval = CMTime(
            seconds: ContentGuardConfig.captureIntervalSeconds,
            preferredTimescale: 600
        )
        config.showsCursor = false

        // Capture at the smallest size the pipeline can actually use, not
        // the display's own resolution (what this used to request). See
        // ContentGuardConfig.maxCaptureDimension's doc comment for why
        // full resolution was pure waste. Aspect ratio is preserved
        // explicitly rather than letting SCStream letterbox a mismatched
        // box: black bars would be real pixels as far as FrameProcessor's
        // skin prefilter is concerned, diluting every ratio it computes.
        // Dimensions are rounded to even numbers - odd capture sizes are
        // accepted but awkward for the compositor, and the rounding error
        // is at most one pixel.
        let captureScale = Double(ContentGuardConfig.maxCaptureDimension)
            / Double(max(display.width, display.height))
        if captureScale < 1.0 {
            config.width = max(2, (Int(Double(display.width) * captureScale) / 2) * 2)
            config.height = max(2, (Int(Double(display.height) * captureScale) / 2) * 2)
        } else {
            // Display is already smaller than the cap - don't upscale it,
            // that would cost bandwidth to invent detail that isn't there.
            config.width = display.width
            config.height = display.height
        }

        // Explicit now that FrameProcessor reads these buffers' bytes
        // directly rather than only ever seeing its own downscale output:
        // BGRA is already SCStreamConfiguration's default, but every
        // byte-offset in FrameProcessor and NudeNetClassifier assumes it,
        // so it should not be left to a default that could change.
        config.pixelFormat = kCVPixelFormatType_32BGRA

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
        // Leeway matching HeartbeatClient's and HeartbeatMonitor's timers,
        // which both already have it - this one was missed. A strict-deadline
        // repeating wakeup keeps the CPU from settling into deeper idle
        // states, the same reasoning AppLockManager's own comments spell out
        // for why it refuses to poll when there is nothing locked. Detecting
        // a dead stream a second later than nominal costs nothing: the whole
        // point of captureStreamStallGraceSeconds being 15s against the
        // daemon's 30s is that it has comfortable margin to spare.
        t.schedule(
            deadline: .now() + ContentGuardConfig.captureStreamStallGraceSeconds,
            repeating: ContentGuardConfig.captureStreamStallGraceSeconds,
            leeway: .seconds(1)
        )
        t.setEventHandler { [weak self] in
            self?.checkStreamHealth()
        }
        t.resume()
        streamHealthTimer = t
    }

    private func checkStreamHealth() {
        // start() hasn't completed its first rebuild yet - nothing to judge
        // as stalled. Deliberately NOT `!streams.isEmpty` (what this used to
        // read) - that guard conflated "never started" with "started, but
        // the last rebuild found zero displays and streams is legitimately
        // empty right now", and the second case is exactly the stall this
        // whole mechanism exists to catch and retry, not a reason to skip
        // it. See rebuildAllStreams()'s doc comment on the zero-displays
        // case for the real incident that surfaced this.
        guard hasStartedOnce else { return }

        // A deliberate pause (either reason - see isPaused's doc comment)
        // is not a stall. Without this, this check would spend the whole
        // pause rebuilding streams it was just told to stop.
        guard !isPaused else { return }

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

    /// Display-only sleep (screen(s) off, machine fully awake - the idle-
    /// timeout / lid-closed-with-external-display case) - distinct from
    /// handleWake() above, which is full system sleep/wake and always needs
    /// a rebuild because SCStream doesn't survive that at all. A stream
    /// generally keeps running through display sleep, still delivering
    /// frames on schedule, just with SCFrameStatus reporting
    /// `.blank`/`.suspended` (already skipped before the downscale/
    /// prefilter/inference pipeline - see carriesNewContent()) - so the
    /// capture stream itself, the outputQueue dispatch behind it, and the
    /// compositor work feeding it all keep running the whole time every
    /// display is dark, for nothing: no content is visible to anyone while
    /// every screen is off, so there is nothing this pipeline could ever
    /// need to catch during that window. Stopping capture outright here is
    /// not a weaker detection posture, the same reasoning that already
    /// applies to skipping `.blank`/`.suspended` frames - it isn't scanning
    /// less of what's on screen, because there is nothing on screen.
    ///
    /// Also correctly covers FallbackCover's own `pmset displaysleepnow`
    /// (HeartbeatMonitor.swift/FallbackCover.swift, daemon side): that's
    /// the same system-level display-sleep event as an idle timeout as far
    /// as this notification is concerned, so a fail-closed cover pauses
    /// capture here too. Still correct, not a new gap - the display the
    /// daemon just put to sleep is, by definition, not showing anything
    /// either, and handleScreensWake() below resumes the instant it's
    /// woken (by the user's password, per FallbackCover's own
    /// documented dependency on "require password immediately after
    /// sleep").
    ///
    /// Reasoned from NSWorkspace's own published behavior for this
    /// notification pair (system-wide, not per-monitor - matches
    /// `pmset displaysleepnow` also being system-wide), not re-confirmed
    /// against real SDK headers the way SCFrameStatus was - worth watching
    /// the real Mac's log after install to confirm this actually fires as
    /// expected with an external display attached, same as every other
    /// "reasoned but not yet independently verified" note in this file.
    @objc private func handleScreensSleep() {
        guard !isPausedForDisplaySleep else { return }
        let wasAlreadyPaused = isPaused
        isPausedForDisplaySleep = true
        logger.log("display(s) asleep - pausing capture")
        Task {
            await stop()
            // Only fire the delegate signal on the aggregate transition -
            // see isPaused's own doc comment. If isPausedForNoRiskyApps was
            // already true, capture was already stopped and
            // captureActive was already reported false; nothing changed
            // from the daemon's perspective.
            if !wasAlreadyPaused {
                delegate?.captureManagerDidPause(self)
            }
        }
    }

    /// Resumes from handleScreensSleep() above. A full rebuild, not a
    /// resume of the old streams - stop() already tore them down, same
    /// "clean rebuild rather than repair a half-dead stream" reasoning
    /// handleWake() already uses. Only actually resumes if
    /// isPausedForNoRiskyApps isn't ALSO still holding the pause - see
    /// isPaused's own doc comment for why reporting captureActive=true
    /// while still genuinely paused for the other reason would be exactly
    /// the dishonest-heartbeat bug already found and fixed once.
    @objc private func handleScreensWake() {
        guard isPausedForDisplaySleep else { return }
        isPausedForDisplaySleep = false
        logger.log("display(s) awake - resuming capture")
        guard !isPaused else { return }
        Task {
            try? await rebuildAllStreams()
            delegate?.captureManagerDidResume(self)
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

    /// Nothing unwhitelisted is currently running - see this method's own
    /// doc comment in the protocol declaration. Same aggregate-transition
    /// reasoning as handleScreensSleep() above: only fire the delegate
    /// signal if this is genuinely a fresh pause, not a redundant call
    /// while already paused for the display-sleep reason.
    func appScopeManagerAllRunningAppsAreSafe(_ manager: AppScopeManager) {
        guard !isPausedForNoRiskyApps else { return }
        let wasAlreadyPaused = isPaused
        isPausedForNoRiskyApps = true
        logger.log("nothing unwhitelisted running - pausing capture")
        Task {
            await stop()
            if !wasAlreadyPaused {
                delegate?.captureManagerDidPause(self)
            }
        }
    }

    /// A non-whitelisted app just launched (or is otherwise now running) -
    /// resume capture immediately if this was the active pause reason.
    /// Same "only actually resume if the other pause source has also
    /// cleared" reasoning as handleScreensWake() above.
    func appScopeManagerNonSafeAppIsRunning(_ manager: AppScopeManager) {
        guard isPausedForNoRiskyApps else { return }
        isPausedForNoRiskyApps = false
        logger.log("non-whitelisted app now running - resuming capture")
        guard !isPaused else { return }
        Task {
            try? await rebuildAllStreams()
            delegate?.captureManagerDidResume(self)
        }
    }
}

extension CaptureManager: SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        let displayID = streams.first(where: { $0.value === stream })?.key
        guard let displayID else { return }

        // Set before the unchanged-frame branch below, deliberately: a frame
        // arriving at all is the liveness signal, whether or not it carries
        // new content. Putting this after that branch would make a static
        // screen look like a dead stream to checkStreamHealth() and trigger
        // a pointless full rebuild every captureStreamStallGraceSeconds.
        lastFrameDeliveredAt = Date()

        // Skip everything downstream for a frame ScreenCaptureKit itself
        // says carries nothing new. On a static screen - most of an ordinary
        // working day - this used to still cost a full CoreImage GPU render
        // pass to 64px plus a per-pixel skin scan, every captureInterval, on
        // every display, purely to re-derive "nothing changed" via the
        // perceptual hash. The compositor already knows that authoritatively
        // and tells us for free.
        //
        // Not a weakening of detection: this is the OS reporting that no
        // pixels changed, not a heuristic guessing that nothing interesting
        // is on screen. The perceptual-hash debounce in FrameProcessor stays
        // exactly as it was, still catching frames that did change but not
        // materially.
        guard carriesNewContent(frameStatus(of: sampleBuffer)) else {
            delegate?.captureManagerDidSkipUnchangedFrame(self)
            return
        }

        // Checked only on the processable path - a skipped frame can
        // legitimately arrive with no image buffer at all, and returning
        // early on that before reporting liveness above would reintroduce
        // the exact stall-detection problem this ordering avoids.
        guard let pixelBuffer = sampleBuffer.imageBuffer else { return }

        delegate?.captureManager(self, didCapture: pixelBuffer, on: displayID)
    }

    /// Reads SCStreamFrameInfoStatus off the sample buffer's attachments -
    /// confirmed against the real ScreenCaptureKit headers in the installed
    /// SDK (SCStream.h), not recalled from memory: Apple's own web docs for
    /// this rendered as an empty JS shell on every fetch attempt, the same
    /// failure mode this project already hit with buf.build and Santa's
    /// docs. The header documents SCFrameStatusIdle verbatim as "new frame
    /// was not generated because the display did not change."
    ///
    ///
    /// Returns .complete when the status can't be read at all - deliberately
    /// failing toward doing the work rather than skipping it. This is a load
    /// shedder, and an unreadable attachment must never become the reason a
    /// real frame went unscanned, the same "when in doubt, don't shed"
    /// policy skinAnalysis() already applies on its own failure paths.
    private func frameStatus(of sampleBuffer: CMSampleBuffer) -> SCFrameStatus {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else {
            return .complete
        }
        return status
    }

    /// Which statuses are worth spending the pipeline on.
    ///
    /// `.complete` is the ordinary "new frame was generated" case.
    ///
    /// `.started` is included deliberately, and it is not an optimisation
    /// detail - it closes a real gap this change would otherwise have
    /// introduced. The header defines it as the first frame sent after a
    /// stream starts, and it carries genuine content. Streams here get
    /// rebuilt constantly (wake from sleep, display hotplug, a safe app
    /// launching, the self-heal timer), so if `.started` were skipped and
    /// the screen then stayed perfectly static, every subsequent frame
    /// would be `.idle` and whatever was on screen at wake would never be
    /// scanned at all. Treating it as processable makes each rebuild
    /// re-examine the screen once, which is exactly the behaviour that
    /// existed before this change.
    ///
    /// Everything else means there is nothing new to look at: `.idle` (the
    /// display did not change), `.blank` (the display has gone blank),
    /// `.suspended` (updates suspended), `.stopped` (the stream stopped).
    private func carriesNewContent(_ status: SCFrameStatus) -> Bool {
        switch status {
        case .complete, .started:
            return true
        case .idle, .blank, .suspended, .stopped:
            return false
        @unknown default:
            // A status this build has never seen - process it rather than
            // skip it, same "when in doubt, don't shed" policy as
            // frameStatus(of:)'s own unreadable-attachment fallback above.
            return true
        }
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
