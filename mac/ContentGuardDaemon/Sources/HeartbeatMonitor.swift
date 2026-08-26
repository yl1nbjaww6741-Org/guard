// Listens on the Unix domain socket, tracks the agent's heartbeat, and
// enforces the grace-window fail-closed check. This is the piece that ties
// EscalationManager, BlackoutTimer, FallbackCover, and AppLockManager
// together into the daemon's actual runtime behavior.

import Foundation

final class HeartbeatMonitor {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.heartbeat")
    private var listenerSource: DispatchSourceRead?
    private var listenerFD: Int32 = -1

    private var lastHeartbeatAt: Date?
    private var lastHeartbeatData: HeartbeatData?
    private var graceCheckTimer: DispatchSourceTimer?

    /// When checkGraceWindow() last actually ran - not the same as
    /// lastHeartbeatAt, which tracks the agent's own heartbeats. This
    /// tracks the daemon's own grace-check timer ticks, so it can notice
    /// when consecutive ticks are further apart in wall-clock time than
    /// the timer's own schedule ever allows for - see
    /// ContentGuardConfig.sleepGapDetectionThresholdSeconds's doc comment.
    private var lastGraceCheckAt: Date?

    /// Set once, in start() - see ContentGuardConfig.agentStartupGraceSeconds's
    /// doc comment for why "never heard from the agent yet" is measured
    /// against this instead of being treated as overdue on the very first
    /// check.
    private var monitorStartedAt: Date?

    /// Tracks frame-count staleness independently of heartbeat arrival - see
    /// ContentGuardConfig.frameStallGraceSeconds's doc comment for why this
    /// exists: a heartbeat arriving on schedule is not proof capture is
    /// actually alive.
    private var lastFramesProcessed: Int?
    private var lastFramesChangedAt: Date?

    /// Heartbeats since the last logged one - see the heartbeat handler
    /// below for why heartbeats are no longer logged individually.
    private var heartbeatsSinceLastLog = 0

    /// ~10 minutes at the 5s heartbeat cadence. A breadcrumb, not a metric -
    /// just enough that "was the agent alive around 3pm?" stays answerable
    /// from the log without every single tick being written down.
    private let heartbeatLogEveryN = 120

    /// True from the moment EscalationManager's kill-counter crosses its
    /// threshold until a real admin release - see markEscalationLockActive()
    /// and the heartbeat handler's auto-clear condition below. Found the
    /// hard way, on the real Mac: without this, an escalation lock behaved
    /// no differently from the ordinary heartbeat-overdue/frame-stall
    /// fail-closed checks (both of which auto-clear on their own once the
    /// agent looks healthy again, by design) - the very next healthy
    /// heartbeat from the relaunched agent, which typically lands within
    /// ~10-15s given how fast launchd relaunches it, auto-cleared the
    /// escalation lock just as fast, undermining the whole point of a
    /// separate, harder-to-shrug-off signal for repeated tampering.
    private var escalationLockActive = false

    private let escalationManager: EscalationManager
    private let blackoutTimer: BlackoutTimer
    private let fallbackCover: FallbackCover
    private let appLockManager: AppLockManager
    private let log: (String) -> Void

    init(
        escalationManager: EscalationManager,
        blackoutTimer: BlackoutTimer,
        fallbackCover: FallbackCover,
        appLockManager: AppLockManager,
        log: @escaping (String) -> Void
    ) {
        self.escalationManager = escalationManager
        self.blackoutTimer = blackoutTimer
        self.fallbackCover = fallbackCover
        self.appLockManager = appLockManager
        self.log = log
    }

    func start() throws {
        monitorStartedAt = Date()
        try bindAndListen()
        startGraceWindowChecker()
    }

    /// Called from main.swift's EscalationManager.onEscalate wiring, in
    /// place of calling fallbackCover.show() directly - that was the actual
    /// bug (see escalationLockActive's doc comment): calling show() alone,
    /// with nothing marking the lock as escalation-sourced, meant the very
    /// next healthy heartbeat auto-cleared it via the same path that
    /// legitimately auto-clears an ordinary fail-closed cover. Routing this
    /// through here instead means the auto-clear check itself can tell the
    /// difference and refuse to clear until a real admin release.
    func markEscalationLockActive() {
        queue.async { [weak self] in
            guard let self else { return }
            self.escalationLockActive = true
            self.fallbackCover.show()
        }
    }

    // MARK: - Socket setup

    private func bindAndListen() throws {
        // Remove a stale socket file from a previous run, if any -
        // otherwise bind() fails with "address already in use."
        unlink(ContentGuardConfig.socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: "HeartbeatMonitor", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket() failed"])
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        ContentGuardConfig.socketPath.withCString { path in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { dest in
                _ = strcpy(dest, path)
            }
        }
        let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { rawAddr -> Int32 in
            rawAddr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(fd, sockaddrPtr, addrSize)
            }
        }
        guard bound == 0 else {
            close(fd)
            throw NSError(domain: "HeartbeatMonitor", code: 2, userInfo: [NSLocalizedDescriptionKey: "bind() failed"])
        }

        // Root-owned (the daemon runs as root), but the agent (running as
        // the logged-in user) needs to connect and write to it - matches
        // the socket path's own doc comment in Config.swift.
        chmod(ContentGuardConfig.socketPath, 0o666)

        guard listen(fd, 8) == 0 else {
            close(fd)
            throw NSError(domain: "HeartbeatMonitor", code: 3, userInfo: [NSLocalizedDescriptionKey: "listen() failed"])
        }

        listenerFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            self?.acceptConnection()
        }
        source.resume()
        listenerSource = source
    }

    private func acceptConnection() {
        let clientFD = accept(listenerFD, nil, nil)
        guard clientFD >= 0 else { return }

        // Each connection gets its own read loop on a background thread -
        // blocking I/O is fine here since it's isolated per-connection, and
        // there's only ever one real client (the agent) at a time in
        // practice.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let connection = IPCConnection(fileDescriptor: clientFD)
            while true {
                guard let message = try? connection.receive() else { break }
                self?.handle(message)
            }
        }
    }

    // MARK: - Message handling

    private func handle(_ message: IPCMessage) {
        switch message {
        case .heartbeat(let data):
            queue.async { [weak self] in
                guard let self else { return }
                let isNewProcess = self.lastHeartbeatData?.pid != data.pid
                let captureStateChanged = self.lastHeartbeatData?.captureActive != data.captureActive
                self.lastHeartbeatAt = Date()
                self.lastHeartbeatData = data

                // Frame-count staleness tracked separately from heartbeat
                // arrival - see ContentGuardConfig.frameStallGraceSeconds's
                // doc comment. A new process always counts as "just
                // changed" (its own frame counter starts fresh at 0, so it
                // trivially differs from whatever the previous process last
                // reported) - correct, since a freshly (re)started process
                // hasn't stalled, it just hasn't produced a frame yet.
                //
                // A captureActive transition false -> true gets the exact
                // same treatment, for the exact same reason - found live
                // (a real "have to unlock twice" report): CaptureManager's
                // display-sleep pause (see its handleScreensSleep() doc
                // comment) correctly keeps this false, and therefore
                // framesStalled below correctly gated off, for the whole
                // time the display is asleep - but lastFramesChangedAt
                // itself sits frozen that entire time, since nothing
                // updates it just because captureActive changed. The
                // instant capture resumes and reports captureActive=true
                // again, rebuildAllStreams() is still in flight
                // (framesProcessed hasn't incremented yet) - if this
                // heartbeat's grace-window check happens to land in that
                // window, it measured "time since frames last changed"
                // against a timestamp from before the display ever slept,
                // which can trivially exceed frameStallGraceSeconds after
                // being locked for any real length of time. That read a
                // legitimate, still-rebuilding resume as a genuine stall
                // and fired fallbackCover.show() -> pmset displaysleepnow
                // right after a real unlock, forcing a second one. A race
                // (only when the check lands in that exact narrow window),
                // matching the reported "sometimes," not every time.
                let captureJustResumed = captureStateChanged && data.captureActive
                if isNewProcess || captureJustResumed || data.framesProcessed != self.lastFramesProcessed {
                    self.lastFramesChangedAt = Date()
                }
                self.lastFramesProcessed = data.framesProcessed

                if isNewProcess {
                    self.escalationManager.watchNewAgentProcess(pid: data.pid)
                }

                // Log on transitions (new agent process, captureActive
                // flipping) plus a periodic breadcrumb - NOT on every
                // heartbeat, which is what this used to do: one line every
                // 5 seconds, ~17k lines a day, each write keeping the disk
                // from idling, through a log with no rotation, for as long
                // as the machine is up. The transitions are the information;
                // a steady stream of identical healthy lines was pure cost.
                // Unhealthy states still log through their own paths
                // (checkGraceWindow, the escalation-lock branch below), so
                // nothing that mattered for debugging is quieter than it was.
                self.heartbeatsSinceLastLog += 1
                if isNewProcess || captureStateChanged || self.heartbeatsSinceLastLog >= self.heartbeatLogEveryN {
                    self.heartbeatsSinceLastLog = 0
                    self.log("heartbeat: pid=\(data.pid) captureActive=\(data.captureActive) frames=\(data.framesProcessed) modelHash=\(data.modelHash)")
                }

                // Used to be "a heartbeat arriving at all means the agent
                // can cover the screen itself" - proven wrong on the real
                // Mac: a stalled SCStream keeps sending perfectly healthy-
                // looking heartbeats (captureActive=true) with a frozen
                // frame count. Only lift a fallback cover for a heartbeat
                // that's actually evidence of live capture, not just of a
                // living process.
                let framesLookStalled = self.isFrameCountStalled(referenceDate: Date())
                if self.fallbackCover.isShowing && !self.blackoutTimer.isActive && !self.escalationLockActive
                    && data.captureActive && !framesLookStalled {
                    self.fallbackCover.hide()
                } else if self.fallbackCover.isShowing && self.escalationLockActive
                    && data.captureActive && !framesLookStalled {
                    // Everything else about this heartbeat looks healthy
                    // enough that the ordinary auto-clear condition above
                    // would have cleared the cover - logged here
                    // specifically so that's directly observable on the
                    // real Mac, since fallbackCover.hide() itself doesn't
                    // log anything on its own and escalation only calls
                    // show() once (unlike the frame-stall path, this
                    // doesn't visibly re-lock the display, so there'd
                    // otherwise be no way to see the fix actually holding).
                    self.log("heartbeat looks healthy but escalation lock is active - staying locked until admin release")
                }
            }
        case .blackout(let data):
            log("blackout triggered: class=\(data.detectionClass) confidence=\(data.confidence)")
            blackoutTimer.start(detection: data)
        case .clearBlackout:
            // Trusted here ONLY because IPCProtocol.swift's contract says
            // this message is never sent except by AdminRelease.swift after
            // a real AuthorizationServices success - see that file and the
            // trust-model comment in Shared/IPCProtocol.swift.
            log("admin release: clearing blackout and escalation state")
            blackoutTimer.adminRelease()
            escalationManager.resetState()
            escalationLockActive = false
            fallbackCover.hide()
        case .appDetection(let data):
            log("detection-triggered quit reported: bundleID=\(data.bundleID)")
            appLockManager.recordDetectionQuit(bundleID: data.bundleID, executablePath: data.executablePath)
        }
    }

    // MARK: - Grace window enforcement

    private func startGraceWindowChecker() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        // Check at roughly the heartbeat interval - frequent enough to
        // notice a gap close to the actual grace deadline, not so frequent
        // it's pointless overhead.
        // Leeway for the same reason as HeartbeatClient's own timer (see
        // there): a coalescible wakeup rather than a guaranteed one. Costs
        // at most a second of extra detection latency on top of the grace
        // deadline itself - this check exists to catch an agent that has
        // been silent for heartbeatGraceSeconds, so a deadline measured in
        // seconds is not sensitive to a second of tick jitter.
        t.schedule(
            deadline: .now(),
            repeating: ContentGuardConfig.heartbeatIntervalSeconds,
            leeway: .seconds(1)
        )
        t.setEventHandler { [weak self] in
            self?.checkGraceWindow()
        }
        t.resume()
        graceCheckTimer = t
    }

    private func checkGraceWindow() {
        // Detect a real System Sleep by looking at the gap between this
        // grace-check tick and the last one, rather than trusting the
        // timer's own nominal schedule - see
        // ContentGuardConfig.sleepGapDetectionThresholdSeconds's doc
        // comment for why DispatchSourceTimer ticks pause (not "fire late")
        // during real sleep, and why this can't be spoofed by killing the
        // agent process alone. A detected gap resets lastHeartbeatAt to now,
        // exactly as if a heartbeat had just arrived - the agent genuinely
        // could not have sent one while the whole machine was suspended,
        // so a missing heartbeat during that gap is not evidence of
        // anything wrong.
        let now = Date()
        if let lastGraceCheckAt,
           now.timeIntervalSince(lastGraceCheckAt) > ContentGuardConfig.sleepGapDetectionThresholdSeconds {
            log("grace-check gap of \(now.timeIntervalSince(lastGraceCheckAt))s detected - system was likely asleep, not agent failure - resetting heartbeat grace window")
            lastHeartbeatAt = now
        }
        lastGraceCheckAt = now

        let graceDeadline = ContentGuardConfig.heartbeatGraceSeconds
        let heartbeatOverdue: Bool
        if let lastHeartbeatAt {
            heartbeatOverdue = Date().timeIntervalSince(lastHeartbeatAt) > graceDeadline
        } else if let monitorStartedAt {
            // Never heard from the agent this daemon instance's life yet.
            // Used to be treated as overdue immediately - proven wrong on
            // the real Mac by a full reboot: the agent needs real
            // wall-clock time after login to spin up ScreenCaptureKit and
            // send its first heartbeat, and RunningAppCheck sees ordinary
            // login items relaunching as "risky" during that exact window,
            // which locked the screen seconds after a normal login. See
            // ContentGuardConfig.agentStartupGraceSeconds's doc comment for
            // why a bounded, one-time startup grace period is the right
            // fix rather than reverting to "wait a full heartbeatGraceSeconds"
            // (too slow for the real mid-session-restart case this
            // originally protected) or removing the check entirely (would
            // reopen that gap for good).
            heartbeatOverdue = Date().timeIntervalSince(monitorStartedAt) > ContentGuardConfig.agentStartupGraceSeconds
        } else {
            // start() hasn't run yet - shouldn't be reachable since
            // graceCheckTimer is only created inside start(), but fail
            // closed rather than open if this is ever hit anyway.
            heartbeatOverdue = true
        }

        // A second, independent failure signal - see
        // ContentGuardConfig.frameStallGraceSeconds's doc comment. Found on
        // the real Mac: heartbeats can keep arriving exactly on schedule
        // (heartbeatOverdue staying false the whole time) from a process
        // whose SCStream died silently underneath it, with captureActive
        // stuck reporting true. Gated on captureActive being true at all -
        // if the agent's own heartbeat is honestly reporting capture as
        // down, that's not a new signal this needs to add anything to.
        let framesStalled = lastHeartbeatData?.captureActive == true
            && isFrameCountStalled(referenceDate: Date())

        guard heartbeatOverdue || framesStalled else { return }
        guard RunningAppCheck.isRiskyAppRunning() else { return }

        if !fallbackCover.isShowing {
            if heartbeatOverdue {
                log("agent heartbeat overdue and a risky app is running - failing closed")
            } else {
                log("agent heartbeats arriving but frame count has stalled and a risky app is running - failing closed")
            }
        }
        fallbackCover.show()
    }

    /// True if capture claims to be active (per the most recent heartbeat)
    /// but framesProcessed hasn't actually advanced within
    /// frameStallGraceSeconds. `lastFramesChangedAt == nil` means no
    /// heartbeat has been judged yet, not that anything is stalled - the
    /// heartbeatOverdue check above already covers that "no signal at all"
    /// case on its own.
    private func isFrameCountStalled(referenceDate: Date) -> Bool {
        guard let lastFramesChangedAt else { return false }
        return referenceDate.timeIntervalSince(lastFramesChangedAt) > ContentGuardConfig.frameStallGraceSeconds
    }
}

/// The daemon has no WindowServer/GUI session of its own (see
/// FallbackCover.swift's doc comment), so it can't use NSWorkspace to
/// enumerate running applications the way AppScopeManager does on the agent
/// side. This is a coarser, process-table-based approximation using sysctl -
/// good enough to decide "should I fail closed," not a full mirror of the
/// agent's own app-scoping logic. Worth tuning once running for real; this
/// is deliberately conservative (checks executable path fragments, not a
/// precise bundle-ID match) since a false positive here just means an extra
/// fallback cover, while a false negative means a real gap.
enum RunningAppCheck {
    private static let riskyPathFragments = [
        "Google Chrome.app",
    ]

    static func isRiskyAppRunning() -> Bool {
        for (_, path) in ProcessEnumeration.runningProcesses() {
            if riskyPathFragments.contains(where: { path.contains($0) }) {
                return true
            }
            if path.hasPrefix("/Applications/"),
               !ContentGuardConfig.safeAppBundleIDs.contains(where: { path.contains($0) }) {
                return true
            }
        }
        return false
    }
}
