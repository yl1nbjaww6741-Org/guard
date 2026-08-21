// Wire protocol between ContentGuardAgent (runs as the logged-in user) and
// ContentGuardDaemon (runs as root), over the Unix domain socket at
// ContentGuardConfig.socketPath.
//
// Framing: each message is a 4-byte big-endian length prefix followed by
// that many bytes of JSON. Unix domain sockets are streams, not datagrams -
// without a length prefix there's no way to know where one message ends and
// the next begins once TCP/socket buffering coalesces or splits writes.
//
// Trust model, worth being explicit about: the socket itself is root-owned
// but user-writable, so any local process running as the logged-in user can
// connect and send messages, including a `clearBlackout`. That's fine for
// `heartbeat` and `blackout` (the daemon treats those as informational, not
// as an escalation of privilege - a fake heartbeat just delays detection of
// agent-down, which the grace-window check already tolerates briefly, and a
// fake `blackout` just covers the screen, which is the fail-safe direction
// anyway). It is NOT fine for `clearBlackout` on its own - the daemon must
// NOT treat "a message arrived on the socket claiming to be clearBlackout"
// as sufficient authorization. AdminRelease.swift is responsible for running
// a real AuthorizationServices check (kAuthorizationFlagInteractionAllowed)
// BEFORE it ever sends this message; HeartbeatMonitor.swift's handling of
// `clearBlackout` must treat it as already-authorized by the time it arrives
// and never invoke it from any other code path. This is a "the protocol
// can't enforce this, the callers must" situation - documented here so it
// doesn't get missed when either side is touched later.

import Foundation

enum IPCMessage: Codable {
    case heartbeat(HeartbeatData)
    case blackout(BlackoutData)
    case clearBlackout // only ever send this from AdminRelease, after a real auth check
}

struct HeartbeatData: Codable {
    let timestamp: TimeInterval
    let captureActive: Bool
    let modelHash: String
    let framesProcessed: Int
}

struct BlackoutData: Codable {
    let confidence: Float
    let detectionClass: String
    let timestamp: TimeInterval
}

// MARK: - Framing

enum IPCFrameError: Error {
    case connectionClosed
    case messageTooLarge(Int)
}

enum IPCFraming {
    /// Generous but bounded - a heartbeat/blackout message is a few hundred
    /// bytes of JSON at most. Capping this stops a misbehaving or hostile
    /// peer from claiming an enormous length prefix and making the reader
    /// allocate unbounded memory.
    static let maxMessageBytes = 64 * 1024

    static func encode(_ message: IPCMessage) throws -> Data {
        let payload = try JSONEncoder().encode(message)
        var frame = Data()
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        frame.append(payload)
        return frame
    }

    static func decode(_ payload: Data) throws -> IPCMessage {
        try JSONDecoder().decode(IPCMessage.self, from: payload)
    }
}

// MARK: - Socket I/O

/// Thin wrapper around a connected Unix domain socket file descriptor,
/// shared by both the agent's client role (HeartbeatClient.swift) and the
/// daemon's server role (HeartbeatMonitor.swift). Blocking I/O deliberately -
/// both sides talk to this from a dedicated background thread/queue, not the
/// main run loop, so blocking reads/writes here don't stall anything else.
final class IPCConnection {
    private let fileDescriptor: Int32

    init(fileDescriptor: Int32) {
        self.fileDescriptor = fileDescriptor
    }

    deinit {
        close(fileDescriptor)
    }

    func send(_ message: IPCMessage) throws {
        let frame = try IPCFraming.encode(message)
        try frame.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            var totalWritten = 0
            let count = buffer.count
            while totalWritten < count {
                let written = write(fileDescriptor, buffer.baseAddress!.advanced(by: totalWritten), count - totalWritten)
                if written <= 0 {
                    throw IPCFrameError.connectionClosed
                }
                totalWritten += written
            }
        }
    }

    /// Blocks until a full message has arrived, the peer closes the
    /// connection, or the message length is rejected as too large.
    func receive() throws -> IPCMessage {
        let lengthData = try readExactly(4)
        let length = lengthData.withUnsafeBytes { $0.load(as: UInt32.self) }.bigEndian
        guard length <= IPCFraming.maxMessageBytes else {
            throw IPCFrameError.messageTooLarge(Int(length))
        }
        let payload = try readExactly(Int(length))
        return try IPCFraming.decode(payload)
    }

    private func readExactly(_ count: Int) throws -> Data {
        var buffer = Data(count: count)
        var totalRead = 0
        try buffer.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            while totalRead < count {
                let n = read(fileDescriptor, raw.baseAddress!.advanced(by: totalRead), count - totalRead)
                if n <= 0 {
                    throw IPCFrameError.connectionClosed
                }
                totalRead += n
            }
        }
        return buffer
    }
}
