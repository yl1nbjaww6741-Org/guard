// ContentGuardDaemon entry point. Runs as root via
// LaunchDaemons/com.contentguard.daemon.plist - the tamper anchor: holds the
// blackout timer, watches the agent's heartbeat, escalates on suspicious
// exit patterns, and fails closed via FallbackCover when the agent can't be
// trusted to be covering the screen itself.
//
// Deliberately minimal here - this file wires dependencies together and
// starts the run loop; the actual behavior lives in the files it wires up.

import Foundation
import SystemConfiguration

func currentConsoleUsername() -> String? {
    guard let name = SCDynamicStoreCopyConsoleUser(nil, nil, nil) as String? else {
        return nil
    }
    // SCDynamicStoreCopyConsoleUser returns "loginwindow" (not a real user)
    // when no one's logged in at the console - filter that out explicitly
    // rather than trying to lock a screen with no session behind it.
    return name == "loginwindow" ? nil : name
}

func logLine(_ message: String) {
    let timestamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(timestamp)] \(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    // TODO: also append to ContentGuardPaths.daemonLogFile once the
    // Installer step creates that directory with the right root-only
    // permissions - stderr alone is enough to develop against and is
    // captured by launchd's own StandardErrorPath redirection either way
    // (see LaunchDaemons/com.contentguard.daemon.plist).
}

let fallbackCover = FallbackCover(consoleUsername: currentConsoleUsername)

let blackoutTimer = BlackoutTimer(
    onStart: { detection in
        logLine("blackout started: \(detection.detectionClass) confidence=\(detection.confidence)")
    },
    onEnd: {
        logLine("blackout ended")
    }
)

let escalationManager = EscalationManager(
    onExit: { kind in
        logLine("agent exit observed: \(kind)")
    },
    onEscalate: {
        logLine("escalation threshold reached - locking screen")
        fallbackCover.show()
    }
)

let appLockManager = AppLockManager(log: logLine)

let heartbeatMonitor = HeartbeatMonitor(
    escalationManager: escalationManager,
    blackoutTimer: blackoutTimer,
    fallbackCover: fallbackCover,
    appLockManager: appLockManager,
    log: logLine
)

do {
    try heartbeatMonitor.start()
    logLine("ContentGuardDaemon started, listening on \(ContentGuardConfig.socketPath)")
} catch {
    logLine("failed to start: \(error)")
    exit(1)
}

// Root LaunchDaemon, no GUI, no main-thread UI work - a plain run loop is
// sufficient to keep the process alive while the dispatch sources above do
// the real work on their own queues.
RunLoop.main.run()
