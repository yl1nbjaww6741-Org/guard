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
}
