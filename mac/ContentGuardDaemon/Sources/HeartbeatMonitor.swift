// Listens on the Unix domain socket, tracks the agent's heartbeat, and
// enforces the grace-window fail-closed check. This is the piece that ties
// EscalationManager, BlackoutTimer, and FallbackCover together into the
// daemon's actual runtime behavior.

import Foundation

final class HeartbeatMonitor {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.heartbeat")
    private var listenerSource: DispatchSourceRead?
    private var listenerFD: Int32 = -1

    private var lastHeartbeatAt: Date?
    private var lastHeartbeatData: HeartbeatData?
    private var graceCheckTimer: DispatchSourceTimer?

    private let escalationManager: EscalationManager
    private let blackoutTimer: BlackoutTimer
    private let fallbackCover: FallbackCover
    private let log: (String) -> Void

    init(
        escalationManager: EscalationManager,
        blackoutTimer: BlackoutTimer,
        fallbackCover: FallbackCover,
        log: @escaping (String) -> Void
    ) {
        self.escalationManager = escalationManager
        self.blackoutTimer = blackoutTimer
        self.fallbackCover = fallbackCover
        self.log = log
    }

    func start() throws {
        try bindAndListen()
        startGraceWindowChecker()
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
                self.lastHeartbeatAt = Date()
                self.lastHeartbeatData = data
                if isNewProcess {
                    self.escalationManager.watchNewAgentProcess(pid: data.pid)
                }
                self.log("heartbeat: pid=\(data.pid) captureActive=\(data.captureActive) frames=\(data.framesProcessed) modelHash=\(data.modelHash)")
                // A heartbeat arriving at all means the agent is alive and
                // able to cover the screen itself - safe to lift a
                // fallback cover that was only up because the agent
                // appeared to be gone.
                if self.fallbackCover.isShowing && !self.blackoutTimer.isActive {
                    self.fallbackCover.hide()
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
            fallbackCover.hide()
        }
    }

    // MARK: - Grace window enforcement

    private func startGraceWindowChecker() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        // Check at roughly the heartbeat interval - frequent enough to
        // notice a gap close to the actual grace deadline, not so frequent
        // it's pointless overhead.
        t.schedule(deadline: .now(), repeating: ContentGuardConfig.heartbeatIntervalSeconds)
        t.setEventHandler { [weak self] in
            self?.checkGraceWindow()
        }
        t.resume()
        graceCheckTimer = t
    }

    private func checkGraceWindow() {
        let graceDeadline = ContentGuardConfig.heartbeatGraceSeconds
        let overdue: Bool
        if let lastHeartbeatAt {
            overdue = Date().timeIntervalSince(lastHeartbeatAt) > graceDeadline
        } else {
            // Never heard from the agent at all (e.g. just booted, agent
            // hasn't started yet) - treat as overdue immediately rather
            // than waiting a full grace window with no signal either way.
            overdue = true
        }

        guard overdue else { return }
        guard RunningAppCheck.isRiskyAppRunning() else { return }

        if !fallbackCover.isShowing {
            log("agent heartbeat overdue and a risky app is running - failing closed")
        }
        fallbackCover.show()
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
        for path in runningExecutablePaths() {
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

    /// Enumerates running processes via sysctl(KERN_PROC_ALL) - available to
    /// root without any GUI session, unlike NSWorkspace.runningApplications.
    private static func runningExecutablePaths() -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return [] }

        let entryCount = size / MemoryLayout<kinfo_proc>.stride
        var procList = [kinfo_proc](repeating: kinfo_proc(), count: entryCount)
        guard sysctl(&mib, u_int(mib.count), &procList, &size, nil, 0) == 0 else { return [] }

        var paths: [String] = []
        for proc in procList {
            var pid = proc.kp_proc.p_pid
            guard pid > 0 else { continue }
            var pathBuffer = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
            let len = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
            if len > 0 {
                paths.append(String(cString: pathBuffer))
            }
        }
        return paths
    }
}
