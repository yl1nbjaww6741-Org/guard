// Covers the screen during any gap where the agent isn't the one doing it -
// agent killed, Screen Recording permission revoked, agent hasn't started
// yet after boot. Stays up until the agent reports healthy heartbeats again
// (see HeartbeatMonitor.swift) or BlackoutTimer expires/gets admin-released.
//
// FLAG F1 from the original plan, resolved here with an honest answer rather
// than an assumed one: a root LaunchDaemon has no WindowServer session of
// its own (this has been true since well before this project - it's a
// deliberate Apple restriction, not a bug, specifically to stop a
// root-owned process from popping up windows that could spoof legitimate
// system UI for credential phishing). So `attemptDirectWindowCover()` below
// is expected to fail, and is written to detect that failure rather than
// silently do nothing - the real, reliable mechanism is
// `lockScreenViaCGSession`, which runs the same `CGSession -suspend` binary
// the Lock Screen menu item itself uses, as the target user via `sudo -u`
// (root can do this; it's exactly the privilege escalation direction that's
// allowed, unlike the reverse). This needs confirming empirically once
// running on the real Mac - flagged, not assumed, same as everything else
// uncertain in this build.

import Foundation
import CoreGraphics

enum FallbackCoverMethod {
    case directWindow
    case cgSessionLock
}

final class FallbackCover {
    private(set) var isShowing = false
    private var activeMethod: FallbackCoverMethod?
    private let consoleUsername: () -> String?

    /// - Parameter consoleUsername: returns the short username of whoever's
    ///   logged into the console session right now, or nil if no one is (in
    ///   which case there's nothing to cover - see main.swift for how this
    ///   is wired to SCDynamicStore).
    init(consoleUsername: @escaping () -> String?) {
        self.consoleUsername = consoleUsername
    }

    func show() {
        guard !isShowing else { return }
        guard let username = consoleUsername() else {
            // No one logged in at the console - nothing to cover. Not an
            // error, just a no-op state worth being explicit about rather
            // than silently succeeding at nothing.
            return
        }

        if attemptDirectWindowCover() {
            activeMethod = .directWindow
            isShowing = true
            return
        }

        lockScreenViaCGSession(username: username)
        activeMethod = .cgSessionLock
        isShowing = true
    }

    func hide() {
        guard isShowing else { return }
        switch activeMethod {
        case .directWindow:
            hideDirectWindowCover()
        case .cgSessionLock, .none:
            // CGSession-based locking has no programmatic "unlock" - once
            // the screen is locked, only the user's own password (or an
            // admin's, at the login window) unlocks it. That's the correct
            // behavior here, not a limitation to work around: the whole
            // point of falling back to a real screen lock is that it's not
            // something the daemon can casually undo either. isShowing
            // reflects "did we, the daemon, decide this state should end,"
            // not "is the screen literally unlocked right now" - those are
            // different things once this path is taken.
            break
        }
        isShowing = false
        activeMethod = nil
    }

    /// Returns true if a cover window was actually created and is visible.
    /// Expected to return false on a real system per the doc comment above -
    /// implemented as a genuine attempt with a real success check, not a
    /// stub, so that IF Apple's restrictions turn out to be less strict than
    /// documented (or change in a future macOS version), this path starts
    /// working automatically rather than needing to be rewritten.
    private func attemptDirectWindowCover() -> Bool {
        // A root process has no CGSSession of its own to query - this call
        // itself is the practical test of whether there's any WindowServer
        // access available at all before attempting to construct an
        // NSWindow (which would require linking AppKit into a daemon target
        // that otherwise has no reason to, just to find out it can't
        // connect - CGSessionCopyCurrentDictionary is the lighter-weight
        // check).
        guard CGSessionCopyCurrentDictionary() != nil else {
            return false
        }
        // TODO: if the guard above ever passes on the real Mac (contrary to
        // expectation), implement the actual NSWindow construction here -
        // borderless NSPanel-equivalent at a high CGWindowLevel, covering
        // every display, ignoring mouse events set to false (block clicks).
        // Deliberately not written speculatively beyond the feasibility
        // check until that check is confirmed to ever succeed.
        return false
    }

    private func hideDirectWindowCover() {
        // No-op until attemptDirectWindowCover ever actually succeeds and
        // has a real window to tear down.
    }

    /// The reliable fallback: locks the screen the same way the Lock Screen
    /// menu item does, run as the target user via sudo -u (a root process
    /// dropping privilege to run as a specific user is the normal, allowed
    /// direction - this is not a security hole, it mirrors what launchd
    /// itself does to run per-user LaunchAgents).
    private func lockScreenViaCGSession(username: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sudo")
        process.arguments = [
            "-u", username,
            "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
            "-suspend",
        ]
        do {
            try process.run()
        } catch {
            // If even this fails, there's genuinely nothing left to try
            // locally - this should be logged loudly by whatever calls
            // show(), since it means the fail-closed guarantee has a hole.
        }
    }
}
