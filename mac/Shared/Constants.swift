// Fixed identifiers shared between ContentGuardAgent and ContentGuardDaemon -
// bundle IDs, LaunchAgent/LaunchDaemon labels, log locations. Distinct from
// Config.swift, which holds *tunable* values (intervals, thresholds) - these
// are identity, not behavior, and changing one means updating the matching
// LaunchAgents/LaunchDaemons plist and re-signing/re-pushing PPPC too.

import Foundation

enum ContentGuardIdentifiers {
    /// Matches profiles/pppc.mobileconfig's __BUNDLE_ID__ once filled in, and
    /// the CFBundleIdentifier baked into the agent's Info.plist.
    static let agentBundleID = "com.contentguard.agent"

    /// The daemon isn't a TCC-gated app (it never touches Screen
    /// Recording/Accessibility directly), so it doesn't need PPPC - but it
    /// does need a stable identifier for its LaunchDaemon label and logging.
    static let daemonBundleID = "com.contentguard.daemon"

    /// Must match LaunchAgents/com.contentguard.agent.plist's Label key.
    static let agentLaunchLabel = "com.contentguard.agent"

    /// Must match LaunchDaemons/com.contentguard.daemon.plist's Label key.
    static let daemonLaunchLabel = "com.contentguard.daemon"
}

enum ContentGuardPaths {
    static let modelDirectory = "/usr/local/share/contentguard"
    static let modelFile = "\(modelDirectory)/nudenet_640m.onnx"

    static let logDirectory = "/usr/local/var/log/contentguard"
    static let agentLogFile = "\(logDirectory)/agent.log"
    static let daemonLogFile = "\(logDirectory)/daemon.log"

    /// Where BlackoutTimer/EscalationManager persist state that needs to
    /// survive a daemon restart (e.g. mid-blackout across a crash/relaunch).
    /// Root-owned, not user-writable - the daemon is the only thing that
    /// should ever touch this.
    static let daemonStateFile = "/usr/local/var/lib/contentguard/state.json"
}
