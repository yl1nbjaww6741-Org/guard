// Tracks how the agent exits and decides whether repeated exits mean
// "probably a bug" (don't escalate) or "probably tampering" (escalate to a
// hard lock). The distinction is the whole point of this file - a naive
// "relaunch N times in M seconds -> lock" counter would also lock the user
// out every time the agent has a real crashing bug, which trains exactly the
// wrong lesson (that hitting the escalation lock is just bad luck, not a
// signal).
//
// The daemon doesn't launch the agent - launchd does, per
// LaunchAgents/com.contentguard.agent.plist - so there's no parent-process
// wait() to observe its exit through. kqueue's EVFILT_PROC with NOTE_EXIT
// lets any sufficiently privileged process (root, here) watch a PID it
// didn't spawn and receive the real exit status/signal when it dies. The PID
// to watch comes from the most recent heartbeat's `pid` field - see
// IPCProtocol.swift.

import Foundation

enum AgentExitKind {
    case crash(signal: Int32) // SIGSEGV, SIGBUS, SIGABRT, SIGILL, SIGTRAP, SIGFPE - a bug, not tampering
    case terminated(signal: Int32) // SIGTERM, SIGKILL - could be tampering, could be a legitimate stop
    case exited(status: Int32) // clean exit() call
    case unknown
}

private let crashSignals: Set<Int32> = [SIGSEGV, SIGBUS, SIGABRT, SIGILL, SIGTRAP, SIGFPE]

final class EscalationManager {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.escalation")
    private var watchedPID: Int32?
    private var procSource: DispatchSourceProcess?

    /// Timestamps of exits counted toward escalation, oldest first. Only
    /// terminated/rapid-cycling exits go in here - crashes never do.
    private var countedExitTimes: [Date] = []

    private let onEscalate: () -> Void
    private let onExit: (AgentExitKind) -> Void

    /// - Parameters:
    ///   - onExit: called on every observed exit, for logging, regardless of whether it counts toward escalation.
    ///   - onEscalate: called once escalationKillCount qualifying exits have landed within escalationWindowSeconds.
    init(onExit: @escaping (AgentExitKind) -> Void, onEscalate: @escaping () -> Void) {
        self.onExit = onExit
        self.onEscalate = onEscalate
    }

    /// Called by AdminRelease.swift's flow (via HeartbeatMonitor) after a
    /// real authorization check succeeds - clears the exit-count history so
    /// a resolved incident doesn't carry residual weight toward a future
    /// escalation it wasn't part of.
    func resetState() {
        queue.async { [weak self] in
            self?.countedExitTimes.removeAll()
        }
    }

    /// Call this every time a heartbeat arrives with a PID different from
    /// whatever's currently being watched - i.e. a new agent process started
    /// (relaunched by launchd, or this is the first heartbeat ever).
    func watchNewAgentProcess(pid: Int32) {
        queue.async { [weak self] in
            guard let self, pid != self.watchedPID else { return }
            self.procSource?.cancel()
            self.watchedPID = pid

            let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: self.queue)
            source.setEventHandler { [weak self] in
                self?.handleExit(pid: pid)
            }
            source.resume()
            self.procSource = source
        }
    }

    private func handleExit(pid: Int32) {
        let kind = Self.classifyExit(pid: pid)
        onExit(kind)

        switch kind {
        case .crash:
            // A bug, not tampering - deliberately does not count toward
            // escalation, per the spec's own explicit call-out of this
            // distinction. Repeated crashes are still visible in the log
            // for whoever's debugging the agent, just not treated as an
            // attack.
            return
        case .terminated, .exited, .unknown:
            recordQualifyingExit()
        }
    }

    private func recordQualifyingExit() {
        let now = Date()
        countedExitTimes.append(now)
        let windowStart = now.addingTimeInterval(-ContentGuardConfig.escalationWindowSeconds)
        countedExitTimes.removeAll { $0 < windowStart }

        if countedExitTimes.count >= ContentGuardConfig.escalationKillCount {
            countedExitTimes.removeAll()
            onEscalate()
        }
    }

    /// Reads the real exit status via waitid/proc_pidinfo-equivalent. Darwin
    /// doesn't give a non-parent process wait()'s exit status directly, but
    /// EVFILT_PROC's NOTE_EXITSTATUS data (delivered by the kqueue event) or
    /// a subsequent proc_pidinfo lookup on the zombie fills the same role -
    /// implemented via posix_spawn's family of syscalls in
    /// AppKit/Foundation isn't the fit here, this is real BSD syscall
    /// territory. Left as a documented interface: fill in with
    /// `waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT)` (or the
    /// NOTE_EXITSTATUS value carried on the DispatchSourceProcess event's
    /// `data`, which is simpler and avoids the ownership/reaping question
    /// entirely for a non-parent watcher) once this is wired up on the real
    /// system - needs verifying against the actual Darwin behavior on the
    /// signing test's Mac, not something to assume from documentation alone.
    private static func classifyExit(pid: Int32) -> AgentExitKind {
        // TODO: pull the real signal/status once this is running on the
        // actual Mac (see doc comment above) - .unknown is a safe default
        // in the meantime since .unknown counts toward escalation (fails
        // closed: an exit we can't classify is treated as suspicious, not
        // benignly ignored).
        .unknown
    }
}
