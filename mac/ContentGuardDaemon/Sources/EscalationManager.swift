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

    /// A single dedicated kqueue for the whole manager's lifetime, read by
    /// one background thread blocked in kevent() - see readLoop() and
    /// watch(pid:)'s doc comments for why this exists instead of
    /// DispatchSource.makeProcessSource: that wrapper (used here until this
    /// was actually verified against real Darwin behavior, per the module
    /// doc comment above) only surfaces a bitmask of *which* event types
    /// fired - .exit, .fork, .exec, .signal - via its own .data property.
    /// It does not expose the raw kevent `data` field, which is the only
    /// place NOTE_EXITSTATUS actually delivers the real wait-status
    /// integer. Registering and reading that field requires the raw
    /// syscalls directly; nothing in Swift's Dispatch wrapper reaches it.
    private let kq: Int32
    private var readThread: Thread?

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
        self.kq = kqueue()
        guard kq != -1 else {
            // Exceptionally rare (resource exhaustion) - but real, and
            // worth being loud about rather than silently disabling
            // escalation detection. Deliberately does NOT start the read
            // loop in this case: kevent() on an invalid fd fails
            // immediately rather than blocking, which would otherwise
            // busy-spin readLoop() forever for no benefit. watch(pid:)/
            // stopWatching(pid:) below already no-op harmlessly against
            // a bad fd, so the rest of the daemon keeps running - this
            // one piece of tamper detection is just silently absent,
            // which is exactly why this is logged loudly instead.
            NSLog("ContentGuardDaemon: EscalationManager failed to create kqueue - exit-based tamper detection is disabled for this run")
            return
        }
        startReadLoop()
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
            // Best-effort cleanup of the previous registration. In the
            // normal case this is already gone by now: EV_ONESHOT removes
            // it automatically the moment the old process's real exit
            // event fires, which happens well before a *new* heartbeat
            // (arriving on the next ~5s tick, after launchd has already
            // noticed the death and relaunched) shows up here. Harmless
            // either way - kevent() with EV_DELETE on an already-removed
            // or nonexistent registration just fails quietly (ENOENT).
            if let previous = self.watchedPID {
                self.stopWatching(pid: previous)
            }
            self.watchedPID = pid
            self.watch(pid: pid)
        }
    }

    private func handleExit(pid: Int32, rawStatus: Int32) {
        let kind = Self.classifyExit(rawStatus: rawStatus)
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

    // MARK: - kqueue exit watching

    /// Registers interest in `pid`'s exit. EV_ONESHOT: this registration
    /// removes itself the moment it fires, matching the "watch exactly one
    /// exit per watched process" model watchNewAgentProcess implements -
    /// no explicit cleanup needed on the happy path.
    ///
    /// NOTE_EXITSTATUS is the actual point of all of this: without it,
    /// EVFILT_PROC's NOTE_EXIT alone still fires reliably, but the kevent's
    /// `data` field is left meaningless. With it, `data` carries the same
    /// wait-status integer POSIX wait()/waitid() would give a real parent -
    /// see classifyExit(rawStatus:) for how that's decoded.
    private func watch(pid: Int32) {
        var event = kevent(
            ident: UInt(pid),
            filter: Int16(EVFILT_PROC),
            flags: UInt16(EV_ADD | EV_ONESHOT),
            fflags: UInt32(NOTE_EXIT) | UInt32(NOTE_EXITSTATUS),
            data: 0,
            udata: nil
        )
        // Registration-only call: changelist has one entry, eventlist is
        // empty (nil/0), so this doesn't block and doesn't return an event
        // - it just tells the kernel what to watch for. The actual event
        // arrives later, asynchronously, in readLoop().
        _ = kevent(kq, &event, 1, nil, 0, nil)
    }

    private func stopWatching(pid: Int32) {
        var event = kevent(
            ident: UInt(pid),
            filter: Int16(EVFILT_PROC),
            flags: UInt16(EV_DELETE),
            fflags: 0,
            data: 0,
            udata: nil
        )
        _ = kevent(kq, &event, 1, nil, 0, nil)
    }

    /// One dedicated thread, blocked in kevent() for the manager's entire
    /// lifetime. kqueue is documented as thread-safe for concurrent use -
    /// registrations from watch(pid:)/stopWatching(pid:) on the `queue`
    /// DispatchQueue and blocking reads here on this separate thread hit
    /// the same kq fd concurrently with no additional locking needed.
    private func startReadLoop() {
        let thread = Thread { [weak self] in
            self?.readLoop()
        }
        thread.name = "com.contentguard.daemon.escalation.kqueue"
        thread.start()
        readThread = thread
    }

    private func readLoop() {
        while true {
            var event = kevent(ident: 0, filter: 0, flags: 0, fflags: 0, data: 0, udata: nil)
            // No timeout (nil) - blocks indefinitely until an exit this
            // manager registered for actually happens. That's the whole
            // point: this thread does nothing until there's real work.
            let n = kevent(kq, nil, 0, &event, 1, nil)
            guard n > 0 else {
                // A transient error (e.g. EINTR from a delivered signal)
                // rather than real data - retry rather than let this
                // thread die, since a dead watcher means silent,
                // permanent loss of exit-tampering detection for the rest
                // of the daemon's lifetime.
                continue
            }

            let pid = Int32(event.ident)
            let rawStatus = Int32(event.data)
            queue.async { [weak self] in
                self?.handleExit(pid: pid, rawStatus: rawStatus)
            }
        }
    }

    /// Decodes the raw wait-status integer NOTE_EXITSTATUS delivers,
    /// following the same bit layout POSIX's WIFEXITED/WEXITSTATUS/
    /// WIFSIGNALED/WTERMSIG macros use (stable, documented BSD/Darwin ABI -
    /// hand-decoded here rather than relying on those macros importing
    /// into Swift, since C function-like macros generally don't bridge):
    /// the low 7 bits are the terminating signal number, or zero if the
    /// process called exit()/_exit() normally, in which case the next
    /// byte up holds the actual exit code. Bit 0x80 (core dump flag) is
    /// masked off - not needed here.
    private static func classifyExit(rawStatus: Int32) -> AgentExitKind {
        let signalBits = rawStatus & 0x7f
        if signalBits == 0 {
            let exitCode = (rawStatus >> 8) & 0xff
            return .exited(status: exitCode)
        }
        let signal = signalBits
        if crashSignals.contains(signal) {
            return .crash(signal: signal)
        }
        return .terminated(signal: signal)
    }
}
