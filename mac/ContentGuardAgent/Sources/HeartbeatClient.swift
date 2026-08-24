// Sends heartbeats to the daemon every 5 seconds over the shared Unix
// domain socket, and relays blackout detections the moment they happen
// (not batched into the next heartbeat - a detection should reach the
// daemon as fast as possible, not wait up to 5 seconds for the next tick).

import Foundation

final class HeartbeatClient {
    private let queue = DispatchQueue(label: "com.contentguard.agent.heartbeat")
    private var connection: IPCConnection?
    private var heartbeatTimer: DispatchSourceTimer?
    private var reconnectTimer: DispatchSourceTimer?

    private(set) var framesProcessed: Int = 0
    var captureActive: Bool = false
    var modelHash: String = ""

    func start() {
        connectSocket()
        let t = DispatchSource.makeTimerSource(queue: queue)
        // Leeway lets the OS coalesce this wakeup with others already
        // scheduled nearby instead of demanding its own, which is what
        // actually costs battery on an otherwise idle machine - the work
        // in sendHeartbeat() is trivial, the guaranteed wakeup every
        // heartbeatIntervalSeconds for the machine's whole uptime is not.
        // Safe against the daemon's heartbeatGraceSeconds (15s): this
        // jitter is per-tick, not cumulative, so even a consistently
        // late 6s cadence leaves the "time since last heartbeat" the
        // daemon actually measures far below its deadline.
        t.schedule(
            deadline: .now(),
            repeating: ContentGuardConfig.heartbeatIntervalSeconds,
            leeway: .seconds(1)
        )
        t.setEventHandler { [weak self] in
            self?.sendHeartbeat()
        }
        t.resume()
        heartbeatTimer = t
    }

    func recordFrameProcessed() {
        queue.async { [weak self] in
            self?.framesProcessed += 1
        }
    }

    /// Currently unused by main.swift's detection path - the "quit the
    /// frontmost app, don't blackout" decision means detections no longer
    /// notify the daemon at all. Kept rather than deleted: it's real,
    /// working capability (daemon-side handling in HeartbeatMonitor.swift
    /// still exists too), not dead code from an abandoned direction - just
    /// not currently called. Revisit if the quit-only approach ever needs
    /// daemon-side awareness added back.
    func sendBlackout(_ detection: BlackoutData) {
        queue.async { [weak self] in
            self?.trySend(.blackout(detection))
        }
    }

    /// Called by main.swift's quitFrontmostApp() every time it actually
    /// force-terminates an app for a real detection - see
    /// AppLockManager.swift on the daemon side for what happens with these.
    /// Same "send it now, don't batch into the next heartbeat" reasoning as
    /// sendBlackout above.
    func sendAppDetection(bundleID: String, executablePath: String) {
        queue.async { [weak self] in
            let data = AppDetectionData(
                bundleID: bundleID,
                executablePath: executablePath,
                timestamp: Date().timeIntervalSince1970
            )
            self?.trySend(.appDetection(data))
        }
    }

    // MARK: - Connection management

    // Named connectSocket(), not connect() - a same-named instance method
    // shadows the global Darwin connect(2) call used inside it, and Swift's
    // unqualified name lookup inside a class prefers the local member over
    // the module-level C function regardless of differing arity, which
    // turns the call below into a compile error rather than silently doing
    // the wrong thing. Renaming avoids the ambiguity outright rather than
    // qualifying every call site as Darwin.connect(...).
    private func connectSocket() {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            scheduleReconnect()
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        ContentGuardConfig.socketPath.withCString { path in
            withUnsafeMutablePointer(to: &addr.sun_path.0) { dest in
                _ = strcpy(dest, path)
            }
        }
        let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &addr) { rawAddr -> Int32 in
            rawAddr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                connect(fd, sockaddrPtr, addrSize)
            }
        }
        guard connected == 0 else {
            close(fd)
            scheduleReconnect()
            return
        }

        connection = IPCConnection(fileDescriptor: fd)
    }

    private func scheduleReconnect() {
        reconnectTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        // Retry at the same cadence as the heartbeat interval - the daemon
        // should always be running (it's a LaunchDaemon with KeepAlive), so
        // a missing socket almost always means "daemon still starting up,"
        // not a permanent condition worth backing off from.
        t.schedule(deadline: .now() + ContentGuardConfig.heartbeatIntervalSeconds)
        t.setEventHandler { [weak self] in
            self?.connectSocket()
        }
        t.resume()
        reconnectTimer = t
    }

    private func sendHeartbeat() {
        queue.async { [weak self] in
            guard let self else { return }
            let data = HeartbeatData(
                timestamp: Date().timeIntervalSince1970,
                captureActive: self.captureActive,
                modelHash: self.modelHash,
                framesProcessed: self.framesProcessed,
                pid: ProcessInfo.processInfo.processIdentifier
            )
            self.trySend(.heartbeat(data))
        }
    }

    private func trySend(_ message: IPCMessage) {
        // Used to just call connectSocket() and return here, dropping
        // whatever message triggered this - harmless for a heartbeat (the
        // next 5s tick sends a fresh one regardless), but a real gap for a
        // one-shot message like appDetection: if the connection happened to
        // be nil at the exact moment of a detection, that detection's
        // report was silently lost with nothing to resend it, undermining
        // AppLockManager's whole counter. connectSocket() is synchronous
        // (a blocking connect(2)) and this always runs already dispatched
        // onto `queue`, same as connectSocket() itself, so trying the send
        // immediately after is safe - no new thread-safety concern.
        if connection == nil {
            connectSocket()
        }
        guard let connection else {
            // Still nothing after trying - the daemon's socket genuinely
            // isn't there right now. Not worth retry machinery beyond this:
            // heartbeats self-heal on the next tick regardless, and a lost
            // appDetection just means AppLockManager needs one more real
            // detection to reach its threshold, not a silent, permanent gap.
            return
        }
        do {
            try connection.send(message)
        } catch {
            // Connection died - drop it and let the next heartbeat tick (or
            // the reconnect timer) re-establish it. Deliberately not
            // retrying the send immediately: if the daemon's socket is
            // gone, the daemon itself is either restarting (launchd will
            // bring it back) or something worse is happening, and either
            // way the daemon's own grace-window check is what fails the
            // system closed in the meantime - the agent doesn't need to be
            // clever here, just keep trying to reconnect.
            self.connection = nil
        }
    }
}
