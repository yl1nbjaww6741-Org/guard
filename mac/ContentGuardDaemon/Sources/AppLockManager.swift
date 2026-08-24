// Tracks how many times each app has been force-quit for a real NSFW
// detection, and locks an app out from relaunching for a fixed duration
// once it crosses a threshold. Distinct from BlackoutTimer: that's a
// whole-machine screen cover from the ORIGINAL design (see that file's own
// doc comment) - currently unused, since main.swift's (agent-side) detection
// handler quits the frontmost app instead and deliberately doesn't notify
// the daemon for that path. This is a narrower, per-app response: not
// "cover the whole screen for every detection" but "if the same app keeps
// getting used for this, stop it from reopening for a while" - closing the
// specific tradeoff mac/README.md calls out for the quit-frontmost-app
// design: on its own it does nothing to stop immediately reopening the same
// app/site right after a detection.
//
// State lives here, not in the agent, and enforcement (killing a locked
// app that tries to relaunch) is done directly by this class via root-only
// process killing, not by asking the agent to do it. Same reasoning as
// BlackoutTimer: "only the daemon itself can end it, on its own clock" - a
// lock that depended on the agent staying alive to enforce it would be
// trivially bypassed by killing the agent first, which defeats the point.

import Foundation

final class AppLockManager {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.applock")

    /// Lifetime-until-lock, not a rolling time window - every entry here is
    /// a real detection-triggered quit reported by the agent, not noise
    /// (unlike EscalationManager's exit tracking, which does need a window
    /// to avoid conflating an unrelated crash days apart with real
    /// tampering). Resets to 0 the moment a lock actually triggers.
    private var blockCounts: [String: Int] = [:]
    private var lockedUntil: [String: Date] = [:]
    /// The executable path reported alongside the bundle ID that tripped
    /// each lock - what enforceLocks() actually matches running processes
    /// against, since ProcessEnumeration (proc_pidpath()) returns real
    /// filesystem paths, not bundle identifiers.
    private var lockedPaths: [String: String] = [:]

    private var pollTimer: DispatchSourceTimer?
    private let log: (String) -> Void

    init(log: @escaping (String) -> Void) {
        self.log = log
        // Deliberately does NOT start polling here. There is nothing to
        // enforce until some app is actually locked out, and this daemon
        // runs for the machine's entire uptime - an unconditional
        // appLockPollIntervalSeconds timer meant a strict-deadline wakeup
        // every 2 seconds, forever, whose handler almost always found
        // lockedPaths empty and returned immediately. The handler was
        // cheap; the wakeup itself is not free on battery, because a
        // recurring strict-deadline timer keeps the CPU from settling into
        // its deeper idle states. Polling now starts when a lock is
        // created (recordDetectionQuit) and stops when the last one
        // expires (enforceLocks).
    }

    /// Call every time the agent reports a real detection-triggered quit
    /// (IPCMessage.appDetection, handled in HeartbeatMonitor.swift).
    func recordDetectionQuit(bundleID: String, executablePath: String) {
        queue.async { [weak self] in
            guard let self else { return }

            // Defense in depth: the socket is user-writable by any local
            // process (see IPCProtocol.swift's trust-model comment), so a
            // forged message could name anything, including something on
            // neverTerminateBundleIDs. The agent already filters this
            // before ever sending a report - quitFrontmostApp() returns
            // early for a never-terminate app - but this class does its own
            // killing independently of the agent, so it needs its own
            // refusal to ever add Dock/SystemUIServer/loginwindow/etc. to
            // lockedPaths, not just trust that the message came from a
            // well-behaved agent.
            guard !ContentGuardConfig.neverTerminateBundleIDs.contains(bundleID) else {
                self.log("app-lock: refusing to track \(bundleID) - on the never-terminate list")
                return
            }

            let count = (self.blockCounts[bundleID] ?? 0) + 1
            self.log("app detection recorded: \(bundleID) (\(count)/\(ContentGuardConfig.appBlockCountThreshold))")

            guard count >= ContentGuardConfig.appBlockCountThreshold else {
                self.blockCounts[bundleID] = count
                return
            }

            self.blockCounts[bundleID] = 0
            self.lockedUntil[bundleID] = Date().addingTimeInterval(ContentGuardConfig.appLockDurationSeconds)
            self.lockedPaths[bundleID] = executablePath
            self.log("\(bundleID) hit \(ContentGuardConfig.appBlockCountThreshold) detections - locking it out for \(Int(ContentGuardConfig.appLockDurationSeconds))s")
            self.startPollingIfNeeded()
        }
    }

    /// Must be called on `queue` - reads pollTimer and is called from
    /// recordDetectionQuit's queue.async block.
    private func startPollingIfNeeded() {
        guard pollTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + ContentGuardConfig.appLockPollIntervalSeconds, repeating: ContentGuardConfig.appLockPollIntervalSeconds)
        // No leeway, unlike the daemon's other timers: this one is active
        // enforcement, and appLockPollIntervalSeconds is already justified
        // as tight on purpose (see its doc comment - a locked app visibly
        // flashing open before getting killed undermines the lock). It
        // only runs while a lock is actually held, which is the bounded
        // case worth spending precision on.
        t.setEventHandler { [weak self] in
            self?.enforceLocks()
        }
        t.resume()
        pollTimer = t
    }

    /// Must be called on `queue`, same as startPollingIfNeeded.
    private func stopPolling() {
        pollTimer?.cancel()
        pollTimer = nil
    }

    private func enforceLocks() {
        let now = Date()

        // Drop expired locks first. Collecting keys before mutating rather
        // than removing while iterating lockedUntil directly - Swift
        // dictionaries don't support that safely.
        let expired = lockedUntil.filter { $0.value <= now }.map { $0.key }
        for bundleID in expired {
            lockedUntil.removeValue(forKey: bundleID)
            lockedPaths.removeValue(forKey: bundleID)
            log("app lock expired: \(bundleID)")
        }

        guard !lockedPaths.isEmpty else {
            // Last lock just expired - nothing left to enforce, so stop
            // waking up for it. recordDetectionQuit restarts the timer the
            // next time a lock is actually created.
            stopPolling()
            return
        }

        let processes = ProcessEnumeration.runningProcesses()
        for (bundleID, path) in lockedPaths {
            for process in processes where process.path == path {
                log("\(bundleID) tried to relaunch while locked out - killing pid \(process.pid)")
                kill(process.pid, SIGKILL)
            }
        }
    }
}
