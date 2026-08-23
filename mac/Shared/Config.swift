// Tunable values shared between ContentGuardAgent and ContentGuardDaemon.
// Both targets compile this same file (added to both targets in the Xcode
// project, not a separate framework - keeps the daemon's attack surface
// minimal, no dylib to tamper with). Changing a value here changes both
// sides at once, which is the point: the daemon's grace window and the
// agent's heartbeat interval have to agree, for instance.

import Foundation

enum ContentGuardConfig {
    // MARK: - Capture / detection

    /// Fixed at 3 seconds - matches the Android app's cadence intentionally,
    /// not something to tune per-device. See mac/README.md.
    static let captureIntervalSeconds: TimeInterval = 3.0

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
    /// just when a heartbeat last arrived. 30s is generous versus the
    /// nominal 3s cadence specifically because real multi-display capture
    /// jitter was observed going as high as ~6s between frames even in
    /// confirmed-healthy operation - this needs comfortable margin above
    /// that, not a tight bound.
    static let frameStallGraceSeconds: TimeInterval = 30.0

    /// How long CaptureManager (agent-side) waits since the last frame it
    /// actually delivered before concluding its own SCStream has silently
    /// died and proactively rebuilding it - the self-healing counterpart to
    /// frameStallGraceSeconds above. Found necessary on the real Mac: the
    /// daemon's frame-stall detection can *notice* a dead stream, but its
    /// only lever is repeatedly sleeping the display (FallbackCover), which
    /// does nothing to fix the underlying problem - confirmed live, a stall
    /// that started once just stayed stalled, repeatedly sleeping the
    /// display, until a human ran `launchctl kickstart` by hand. Deliberately
    /// shorter than frameStallGraceSeconds (30s) - this should resolve a
    /// stall well before the daemon's more disruptive fail-closed response
    /// ever needs to fire at all, not race it. See CaptureManager.swift's
    /// startStreamHealthCheck().
    static let captureStreamStallGraceSeconds: TimeInterval = 15.0

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
    static let escalationKillCount: Int = 2
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
