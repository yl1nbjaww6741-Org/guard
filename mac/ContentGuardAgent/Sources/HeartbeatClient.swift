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
        connect()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: ContentGuardConfig.heartbeatIntervalSeconds)
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

    func sendBlackout(_ detection: BlackoutData) {
        queue.async { [weak self] in
            self?.trySend(.blackout(detection))
        }
    }

    // MARK: - Connection management

    private func connect() {
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
            self?.connect()
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
        guard let connection else {
            connect()
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
