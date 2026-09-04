// Tunable values shared between ContentGuardAgent and ContentGuardDaemon.
// Both targets compile this same file (added to both targets in the Xcode
// project, not a separate framework - keeps the daemon's attack surface
// minimal, no dylib to tamper with). Changing a value here changes both
// sides at once, which is the point: the daemon's grace window and the
// agent's heartbeat interval have to agree, for instance.

import Foundation

enum ContentGuardConfig {
    // MARK: - Capture / detection

    /// 5 seconds. Briefly dropped to 3.0 (2026-08-27) after a real live
    /// miss (QuickTime playing content that wasn't caught in time), then
    /// deliberately reverted back to 5.0 the same day: ship the per-window
    /// capture fix (the actual root cause of that miss - see
    /// AppScopeManager.riskyAppWindows()'s doc comment) first, at the
    /// existing 5s cadence, and only pay the extra battery cost of a
    /// faster cadence later if real testing shows detection latency is
    /// still a problem once that fix is in. Originally changed from 3.0 to
    /// 5.0 (2026-08-24) as a battery measure - a deliberate divergence
    /// from the Android app's 3s cadence this originally matched. The real
    /// tradeoff, stated rather than buried: worst-case detection latency
    /// is ~5s, not ~3s. Everything downstream that is defined as a
    /// multiple of this interval (frameStallGraceSeconds at 10x,
    /// captureStreamStallGraceSeconds at 5x) stays at its own 5s-cadence
    /// value accordingly - the margins those grace windows exist to
    /// provide are relative to the cadence, not absolute numbers.
    static let captureIntervalSeconds: TimeInterval = 5.0

    /// Longest-side pixel dimension SCStream is asked to deliver, rather
    /// than the display's own full resolution (what CaptureManager used to
    /// request). Nothing downstream can use more: FrameProcessor downscales
    /// every frame to 64px for the change-hash and skin prefilter, and
    /// NudeNetClassifier's preprocess() hard-rejects anything above 640 in
    /// either dimension because the 640m model's input is a fixed
    /// 640x640 canvas. Capturing a full 1512x982 (a 14" MBP) to feed a
    /// 640px pipeline meant compositing and moving ~5.6x more pixels per
    /// frame, per display, every captureIntervalSeconds, then paying a
    /// second full-resolution CoreImage render pass to throw most of it
    /// away - pure battery cost with nothing to show for it, since the
    /// classifier is mathematically incapable of seeing the extra detail.
    /// Asking ScreenCaptureKit for this size directly gets the scale done
    /// once, in hardware, on the capture path.
    ///
    /// Deliberately equal to the model's input dimension, not smaller:
    /// this is the largest size that costs nothing in detection quality.
    /// Going below 640 WOULD start discarding detail the classifier could
    /// have used, so it is not a free tuning knob for more battery.
    static let maxCaptureDimension: Int = 640

    /// Deliberately narrow, explicit list of processes whose mere
    /// presence (a window on screen) should force capture to resume/stay
    /// on, regardless of AppScopeManager.allRunningRegularAppsAreSafe()'s
    /// own .regular-app-only pause logic - see that method's own doc
    /// comment for the real gap this exists to close (the screenshot
    /// review panel/editor is never a .regular app, so it's invisible to
    /// that check entirely).
    ///
    /// Explicit user request, 2026-09-04, and the right shape for this
    /// check: "allow all other processes and background helpers... even
    /// new ones that pop up... blacklist the screenshot capture process" -
    /// default to NOT forcing capture on for anything, one short, named
    /// exception. This replaced a real, live-found regression in the
    /// first attempt to close the same gap: using "any non-safe window at
    /// all" (AppScopeManager.riskyAppWindows()) as the resume trigger
    /// instead of this short list defeated the entire pause-for-battery
    /// optimization outright - riskyAppWindows() also (correctly, for ITS
    /// OWN purpose of giving every risky window its own dedicated stream)
    /// includes ordinary system chrome that's never owned by a safe-
    /// listed app either (the Dock itself, Control Center, Notification
    /// Center, menu bar extras) - all on screen essentially always, on
    /// any real Mac session. Confirmed live: "no blacklisted apps open,
    /// and the screen is being captured" - the broad check meant capture
    /// could never actually pause at all, not that it correctly resumed
    /// only for the screenshot window specifically.
    ///
    /// com.apple.screencaptureui confirmed as the real owning bundle ID
    /// for the screenshot review panel/editor via a real diagnostic run
    /// on the actual Mac (see git history: "frame delivered from window
    /// <id> owner=com.apple.screencaptureui"), not guessed.
    static let forceCaptureOnBundleIDs: Set<String> = [
        "com.apple.screencaptureui",
    ]

    /// Confidence threshold for NudeNetClassifier before triggering a
    /// blackout. A single borderline frame at ~0.6 shouldn't cost 10
    /// minutes - this is the confirmation gate, distinct from the
    /// skin-tone prefilter's threshold (which is deliberately permissive,
    /// since it's a load shedder, not an acquitter - see
    /// FrameProcessor.swift).
    static let detectionConfidenceThreshold: Float = 0.6

    static let blockedClasses: Set<String> = [
        "FEMALE_BREAST_EXPOSED",
        "FEMALE_GENITALIA_EXPOSED",
        "MALE_GENITALIA_EXPOSED",
        "BUTTOCKS_EXPOSED",
        "ANUS_EXPOSED",
    ]

    /// Apps that never need scanning. Keep this list short and deliberate -
    /// every bundle ID here is a blind spot AppScopeManager won't capture.
    static let safeAppBundleIDs: Set<String> = [
        "com.apple.Terminal",
        "com.apple.finder",
        "com.apple.systempreferences",
        "com.apple.dt.Xcode",
        "com.apple.ActivityMonitor",
    ]

    /// Never force-terminate these, regardless of what's frontmost when a
    /// detection fires - a separate, narrower list from safeAppBundleIDs
    /// above (that one's about what to skip *scanning*; this one's about
    /// what's unsafe to *kill*). Finder auto-relaunches if force-quit, so
    /// it's low-risk, but there's no upside to ever targeting it either.
    /// Dock/SystemUIServer/loginwindow are genuinely dangerous to force-quit
    /// - killing the wrong one can crash the whole GUI session, not just an
    /// app. Includes our own bundle ID as a defensive belt-and-suspenders
    /// (should never be frontmost-and-detected in practice, but "never
    /// terminate yourself" is cheap insurance).
    static let neverTerminateBundleIDs: Set<String> = [
        "com.apple.finder",
        "com.apple.dock",
        "com.apple.systemuiserver",
        "com.apple.loginwindow",
        ContentGuardIdentifiers.agentBundleID,
    ]

    // MARK: - Heartbeat / IPC

    static let heartbeatIntervalSeconds: TimeInterval = 5.0

    /// 3x the heartbeat interval. If the daemon hasn't heard from the agent
    /// within this window *and* a target app or Chrome is running, it
    /// treats that as agent-down and fails closed - see
    /// HeartbeatMonitor.swift.
    static let heartbeatGraceSeconds: TimeInterval = 15.0

    /// 10x the capture interval. Found the hard way, on the real Mac: a
    /// process can stay alive and keep sending perfectly on-schedule
    /// heartbeats with captureActive=true, while the actual SCStream has
    /// silently died underneath it (a real ScreenCaptureKit failure mode -
    /// not every stream death fires SCStreamDelegate.didStopWithError, and
    /// HeartbeatClient.captureActive is a "did start() succeed once" flag,
    /// never re-evaluated - see HeartbeatClient.swift). That leaves the
    /// heartbeatGraceSeconds check above blind: heartbeats keep arriving on
    /// time, so "time since last heartbeat" alone never trips, even though
    /// zero frames have actually been processed in minutes. framesProcessed
    /// is already in every heartbeat and monotonically increases whenever
    /// capture is genuinely alive (FrameProcessor.process() bumps it via a
    /// deferred call on every frame, regardless of skin-ratio outcome) - so
    /// HeartbeatMonitor tracks when that count last actually changed, not
    /// just when a heartbeat last arrived. Generous versus the nominal
    /// cadence specifically because real multi-display capture jitter was
    /// observed going as high as ~2x nominal between frames (measured as
    /// ~6s at the original 3s cadence) even in confirmed-healthy operation
    /// - this needs comfortable margin above that, not a tight bound.
    /// Rescaled 30 -> 50 when captureIntervalSeconds moved 3 -> 5
    /// (2026-08-24), briefly back to 30 alongside a same-day-reverted
    /// 5 -> 3 cadence change (2026-08-27, see captureIntervalSeconds's own
    /// history), then back to 50 once that cadence change was itself
    /// reverted the same day - the margin is a multiple of the cadence,
    /// not an absolute number, so it tracks captureIntervalSeconds's own
    /// current value.
    static let frameStallGraceSeconds: TimeInterval = 50.0

    /// How long CaptureManager (agent-side) waits since the last frame it
    /// actually delivered before concluding its own SCStream has silently
    /// died and proactively rebuilding it - the self-healing counterpart to
    /// frameStallGraceSeconds above. Found necessary on the real Mac: the
    /// daemon's frame-stall detection can *notice* a dead stream, but its
    /// only lever is repeatedly sleeping the display (FallbackCover), which
    /// does nothing to fix the underlying problem - confirmed live, a stall
    /// that started once just stayed stalled, repeatedly sleeping the
    /// display, until a human ran `launchctl kickstart` by hand. Deliberately
    /// shorter than frameStallGraceSeconds (50s) - this should resolve a
    /// stall well before the daemon's more disruptive fail-closed response
    /// ever needs to fire at all, not race it. See CaptureManager.swift's
    /// startStreamHealthCheck(). Rescaled 15 -> 25 alongside
    /// captureIntervalSeconds moving 3 -> 5 (2026-08-24); briefly back to
    /// 15 alongside a same-day-reverted 5 -> 3 cadence change
    /// (2026-08-27, see captureIntervalSeconds's own history), then back
    /// to 25 once that cadence change was itself reverted the same day -
    /// same 5x-the-cadence ratio throughout, tracking
    /// captureIntervalSeconds's own current value.
    static let captureStreamStallGraceSeconds: TimeInterval = 25.0

    /// Found the hard way, on the real Mac, via a full `sudo reboot` (not
    /// just a launchd bootout/bootstrap cycle - see mac/README.md): the
    /// daemon (a LaunchDaemon) comes up at system boot, well before anyone
    /// logs in. HeartbeatMonitor's grace-window check has always treated
    /// "never received a heartbeat this run" as overdue *immediately*
    /// rather than waiting out a full heartbeatGraceSeconds - deliberately,
    /// to close a real gap where a daemon restart mid-session (agent
    /// already running, a risky app already open) shouldn't get a free
    /// pass window with zero protection. But that same immediate check
    /// also fires the instant a user logs in after a real boot: macOS
    /// relaunches login items right away, RunningAppCheck.isRiskyAppRunning()
    /// counts any ordinary /Applications app as risky (not just Chrome -
    /// see that function's own doc comment on why it's deliberately
    /// broad), and the agent's ScreenCaptureKit stream needs real wall-clock
    /// time to spin up and send its first heartbeat - so the very next
    /// grace-check tick (every heartbeatIntervalSeconds) sees "no heartbeat
    /// yet" + "some login item is running" and fails closed within seconds
    /// of typing the login password. Confirmed live: this is exactly what
    /// locked the screen right after a real restart.
    ///
    /// The fix is a one-time startup grace period, timed from when this
    /// daemon instance started (see HeartbeatMonitor.monitorStartedAt) -
    /// once elapsed, the original immediate-overdue behavior applies
    /// permanently for the rest of that daemon instance's life, so this
    /// doesn't reopen an ongoing gap, just delays when the check starts
    /// being strict. Sized well above ordinary login-item-relaunch +
    /// ScreenCaptureKit-startup timing, generous specifically because real
    /// boot conditions (cold caches, everything relaunching at once) are
    /// heavier than steady-state. Doesn't meaningfully weaken the original
    /// mid-session-restart case this replaces either: if the agent was
    /// already alive and heartbeating before the daemon restarted, its
    /// heartbeat timer keeps ticking independently and a fresh heartbeat
    /// should land well under this window regardless - the only case this
    /// grace period actually costs anything against is both the daemon
    /// and the agent dying at the exact same instant during an active
    /// session, which is bounded to this window, not unlimited.
    static let agentStartupGraceSeconds: TimeInterval = 45.0

    /// If the real wall-clock gap between two consecutive grace-window
    /// checks is larger than this, that gap itself is evidence the whole
    /// system was actually asleep for that long - DispatchSourceTimer ticks,
    /// like every other process's scheduling, pause during real System
    /// Sleep. They don't fire "missed" ticks once woken, they just resume -
    /// so a heartbeatOverdue check running for the first time after a real
    /// sleep sees the full sleep duration as "time since last heartbeat,"
    /// even though the agent was never actually unresponsive; it simply
    /// couldn't send heartbeats while the whole machine was suspended
    /// either. Found the hard way on the real Mac: reported as "sometimes
    /// have to unlock twice after waking," distinct from and found after
    /// the captureJustResumed fix in HeartbeatMonitor.swift, which only
    /// covers the separate frame-stall check - this one covers the
    /// heartbeat-arrival check, which had no sleep protection at all.
    ///
    /// 2x heartbeatIntervalSeconds: comfortably above the grace-check
    /// timer's own declared leeway (1s), so ordinary tick jitter should
    /// never approach it, while still catching even a brief lid-close.
    /// This can't be gamed by simply killing the (unprivileged) agent -
    /// the daemon's own grace-check timer cadence is what's measured here,
    /// completely independent of agent state, so a real tamper scenario
    /// still trips heartbeatOverdue correctly after heartbeatGraceSeconds
    /// as designed.
    static let sleepGapDetectionThresholdSeconds: TimeInterval = 10.0

    static let socketPath = "/var/run/contentguard.sock"

    // MARK: - Blackout / escalation

    /// 10 minutes. Held by the daemon, not the agent - killing the agent,
    /// quitting Chrome, closing any app does not cancel this. See
    /// BlackoutTimer.swift.
    static let blackoutDurationSeconds: TimeInterval = 600.0

    /// If the agent exits this many times within escalationWindowSeconds,
    /// EscalationManager locks the screen. Only counts clean exits
    /// (SIGTERM/SIGKILL) or rapid cycling - a crashing agent (SIGSEGV etc)
    /// is treated as a bug, not tampering, and doesn't escalate. See
    /// EscalationManager.swift.
    static let escalationKillCount: Int = 5
    static let escalationWindowSeconds: TimeInterval = 60.0

    // MARK: - Per-app lockout

    /// If the same app is force-quit for a real NSFW detection this many
    /// times, AppLockManager locks it out from relaunching for
    /// appLockDurationSeconds - closing the specific tradeoff called out in
    /// mac/README.md's Phase 2 row: quitFrontmostApp() alone does nothing
    /// on its own to stop immediately reopening the same app/site right
    /// after a detection. Deliberately a plain lifetime-until-lock counter,
    /// not a rolling time window like EscalationManager's exit tracking -
    /// every entry here is a real confirmed classifier detection, not noise
    /// that needs filtering by recency the way an unrelated crash would.
    static let appBlockCountThreshold: Int = 4

    /// 10 minutes. Tracked as its own constant rather than reusing
    /// blackoutDurationSeconds, even though they start at the same value -
    /// the two are conceptually distinct (blackoutDurationSeconds is a
    /// whole-screen cover from the original design, currently unused since
    /// main.swift's detection handler quits the frontmost app instead; this
    /// is a narrower per-app relaunch block) and shouldn't be forced to
    /// always move together just because someone picked the same number
    /// for both.
    static let appLockDurationSeconds: TimeInterval = 600.0

    /// How often AppLockManager polls the process table for a locked app
    /// trying to relaunch. Deliberately tighter than heartbeatIntervalSeconds
    /// - this is active enforcement, not failure detection, and a locked
    /// app visibly flashing open for several seconds before getting killed
    /// undermines the point of locking it out more than a cheap, frequent
    /// sysctl poll costs.
    static let appLockPollIntervalSeconds: TimeInterval = 2.0
}
