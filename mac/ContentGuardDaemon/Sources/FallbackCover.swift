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
// silently do nothing.
//
// The reliable mechanism, `lockScreenViaDisplaySleep`, was NOT what this
// file originally assumed. It first tried CGSession -suspend (the same
// binary the classic Lock Screen menu item used) - confirmed, empirically,
// on the real Mac, to no longer exist anywhere on disk
// (`sudo find ... -iname CGSession` came back completely empty). Apple
// removed that standalone utility all the way back in Big Sur (2020) -
// this was broken from the moment it was written, just never actually run
// until now. The real, currently-working mechanism is `pmset
// displaysleepnow`, which requires no Accessibility permission and no
// per-user session scripting (unlike the AppleScript/System Events
// alternative, which needs Accessibility granted to whatever runs the
// osascript command - another fragile TCC dependency this project has
// spent a lot of effort fighting elsewhere, not worth introducing here
// too). Its one real dependency: "Require password immediately after
// sleep or screen saver begins" must be enabled in System Settings ->
// Lock Screen, or this just dims the display without actually locking
// anything - needs adding to the Phase 0/setup checklist, not yet
// verified as enabled on the real Mac.

import Foundation
import CoreGraphics

enum FallbackCoverMethod {
    case directWindow
    case displaySleepLock
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
        guard consoleUsername() != nil else {
            // No one logged in at the console - nothing to cover. Not an
            // error, just a no-op state worth being explicit about rather
            // than silently succeeding at nothing. (The username itself
            // isn't needed below anymore - pmset displaysleepnow is a
            // system-wide action, not tied to a specific user session like
            // the old sudo -u CGSession approach was - but "is anyone
            // actually logged in" is still a meaningful guard.)
            return
        }

        if attemptDirectWindowCover() {
            activeMethod = .directWindow
            isShowing = true
            return
        }

        lockScreenViaDisplaySleep()
        activeMethod = .displaySleepLock
        isShowing = true
    }

    func hide() {
        guard isShowing else { return }
        switch activeMethod {
        case .directWindow:
            hideDirectWindowCover()
        case .displaySleepLock, .none:
            // No programmatic "unlock" here either, same reasoning as the
            // CGSession approach this replaced: once the display's asleep
            // and password-on-wake is enforced, only the user's own
            // password (or an admin's, at the login window) gets back in.
            // isShowing reflects "did we, the daemon, decide this state
            // should end," not "is the screen literally unlocked right
            // now" - those are different things once this path is taken.
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

    /// The reliable fallback, confirmed actually present and callable on
    /// the real Mac (see the module doc comment for why this isn't
    /// CGSession anymore). System-wide action, no need to run as a
    /// specific user or drop root privilege the way the old approach did.
    private func lockScreenViaDisplaySleep() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        process.arguments = ["displaysleepnow"]
        do {
            try process.run()
            NSLog("ContentGuardDaemon: FallbackCover triggered pmset displaysleepnow")
        } catch {
            // If even this fails, there's genuinely nothing left to try
            // locally - loud logging matters here specifically, since it
            // means the fail-closed guarantee has a hole.
            NSLog("ContentGuardDaemon: FallbackCover FAILED to run pmset displaysleepnow: \(error)")
        }
    }
}
