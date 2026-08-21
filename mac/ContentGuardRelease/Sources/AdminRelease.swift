// The only sanctioned way to end a blackout early or clear escalation state.
// This is its OWN small command-line executable (contentguard-release, built
// as a separate target from the main daemon binary - see mac/Makefile), not
// code that runs inside ContentGuardDaemon itself. The daemon only ever
// trusts a `clearBlackout` IPC message that arrived after this tool already
// ran a real AuthorizationServices check - see the trust-model comment at
// the top of Shared/IPCProtocol.swift. Keeping this as a separate, short-
// lived process rather than an RPC endpoint inside the long-running daemon
// means the AuthorizationServices prompt (and the standard-user's inability
// to answer it without real admin credentials) is the actual gate, not
// anything the daemon itself has to get right about who's asking.
//
// Standard user cannot invoke this successfully: AuthorizationServices'
// system prompt requires credentials for a user in the admin group, which a
// standard-user account (post Phase 5) does not have and cannot supply from
// memory (see mac/README.md's vault design). This tool doesn't need its own
// separate check for "is the caller an admin" - the OS-level auth prompt
// already enforces that; this tool's only job is to run that prompt
// correctly and, on success, tell the daemon to stand down.

import Foundation
import Security

enum AdminReleaseError: Error {
    case authorizationFailed(OSStatus)
    case connectFailed
}

enum AdminReleaseTool {
    /// Entry point for the standalone contentguard-release executable.
    static func run() -> Int32 {
        do {
            try requireAdminAuthorization()
        } catch {
            FileHandle.standardError.write("Admin authorization required and not granted.\n".data(using: .utf8)!)
            return 1
        }

        do {
            try sendClearBlackout()
        } catch {
            FileHandle.standardError.write("Authorized, but could not reach the daemon: \(error)\n".data(using: .utf8)!)
            return 1
        }

        print("Blackout cleared and escalation state reset.")
        return 0
    }

    /// Presents the standard macOS admin-credential prompt via
    /// AuthorizationServices, with interaction explicitly allowed (this is
    /// what makes it show a GUI prompt rather than silently failing when run
    /// from a Terminal without cached credentials). Succeeds only if the
    /// entered credentials belong to an account in the admin group.
    private static func requireAdminAuthorization() throws {
        var authRef: AuthorizationRef?
        var status = AuthorizationCreate(nil, nil, [], &authRef)
        guard status == errAuthorizationSuccess, let authRef else {
            throw AdminReleaseError.authorizationFailed(status)
        }
        defer { AuthorizationFree(authRef, []) }

        let rightName = kAuthorizationRightExecute
        var item = AuthorizationItem(
            name: (rightName as NSString).utf8String!,
            valueLength: 0,
            value: nil,
            flags: 0
        )
        status = withUnsafeMutablePointer(to: &item) { itemPointer -> OSStatus in
            var rights = AuthorizationRights(count: 1, items: itemPointer)
            let flags: AuthorizationFlags = [.interactionAllowed, .extendRights, .preAuthorize]
            return AuthorizationCopyRights(authRef, &rights, nil, flags, nil)
        }
        guard status == errAuthorizationSuccess else {
            throw AdminReleaseError.authorizationFailed(status)
        }
        // Reaching here means the prompt was shown and satisfied by
        // credentials AuthorizationServices accepted for this right - on a
        // default system, kAuthorizationRightExecute requires admin group
        // membership. Worth re-confirming this default hasn't been
        // loosened by any policy in this specific setup once running for
        // real, rather than assuming the OS default silently.
    }

    private static func sendClearBlackout() throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw AdminReleaseError.connectFailed }

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
            throw AdminReleaseError.connectFailed
        }

        let connection = IPCConnection(fileDescriptor: fd)
        try connection.send(.clearBlackout)
    }
}
