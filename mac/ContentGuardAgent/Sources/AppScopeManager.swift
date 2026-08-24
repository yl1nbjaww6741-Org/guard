// Tracks which running applications should be excluded from capture (the
// safe-app list) and resolves that into a concrete window list
// CaptureManager can hand to SCContentFilter. Runs in the agent's own GUI
// session, so unlike the daemon it has full NSWorkspace/AppKit access - app
// launch/quit notifications work normally here.
//
// Design note on the SCContentFilter API: excludingApplications:
// exceptingWindows: exists, but its "exceptingWindows" parameter is an
// *inclusion exception* for the excluded apps (those specific windows ARE
// captured despite belonging to an excluded app) - it is not a general
// "also exclude these other windows" mechanism. Since we need to exclude
// BOTH safe-app windows AND the overlay's own windows at once, and the spec
// itself calls out `excludingWindows:` specifically for the overlay
// exclusion, this class resolves everything down to one plain window list
// and CaptureManager builds a single `SCContentFilter(display:
// excludingWindows:)` from it, rather than trying to combine two different
// filter mechanisms.

import AppKit
import ScreenCaptureKit

protocol AppScopeManagerDelegate: AnyObject {
    /// Called whenever the set of excluded applications changes (an app in
    /// the safe list launched or quit) - CaptureManager should rebuild its
    /// SCContentFilter(s) in response, since SCContentFilter is immutable
    /// once created.
    func appScopeManagerDidUpdateScope(_ manager: AppScopeManager)
}

// NSObject subclass, not a plain Swift class - #selector()/@objc-based
// NotificationCenter target-action (used below) only works on types the
// Objective-C runtime can dispatch to, which requires NSObject inheritance.
final class AppScopeManager: NSObject {
    weak var delegate: AppScopeManagerDelegate?

    private(set) var excludedApplications: [SCRunningApplication] = []
    private var latestContent: SCShareableContent?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppLifecycleChange),
            name: NSWorkspace.didLaunchApplicationNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppLifecycleChange),
            name: NSWorkspace.didTerminateApplicationNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// Refreshes both the excluded-application set and the underlying
    /// SCShareableContent snapshot used to resolve those apps into actual
    /// windows. Call once at startup and again whenever
    /// appScopeManagerDidUpdateScope fires.
    func refresh() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        latestContent = content
        excludedApplications = content.applications.filter { app in
            ContentGuardConfig.safeAppBundleIDs.contains(app.bundleIdentifier)
        }
    }

    /// Windows belonging to any safe-listed app, as of the last refresh().
    /// CaptureManager combines this with its own overlay windows before
    /// building the actual SCContentFilter.
    func safeAppWindows() -> [SCWindow] {
        guard let latestContent else { return [] }
        let excludedBundleIDs = Set(excludedApplications.map(\.bundleIdentifier))
        return latestContent.windows.filter { window in
            guard let owner = window.owningApplication else { return false }
            return excludedBundleIDs.contains(owner.bundleIdentifier)
        }
    }

    /// NSWorkspace posts launch/terminate notifications synchronously on the
    /// main thread, but refresh() has to be async (SCShareableContent's own
    /// API is async) - so this just kicks off a Task rather than doing the
    /// refresh inline. Marked @objc because #selector() in init() above
    /// requires it.
    ///
    /// Filtered to safe-listed apps only - a real battery fix, not a
    /// cosmetic one. These notifications fire for EVERY app launch and
    /// quit, and this handler used to react to all of them unconditionally:
    /// each one cost an SCShareableContent snapshot here, then the delegate
    /// fired appScopeManagerDidUpdateScope, and CaptureManager's response
    /// to that is rebuildAllStreams() - stop every capture stream, take a
    /// SECOND full SCShareableContent snapshot, and rebuild one SCStream
    /// per display. All of that, on every launch or quit of any app all
    /// day, when the exclusion list this class exists to maintain can only
    /// actually change when one of the five safeAppBundleIDs apps launches
    /// or quits. (Each needless rebuild also left a brief capture gap - so
    /// this was costing a little safety along with the battery.)
    ///
    /// Fails toward the old behavior, not away from it: if the notification
    /// doesn't identify the app (userInfo missing or unparseable), refresh
    /// anyway rather than guessing it was irrelevant - refreshing too often
    /// is the cheap mistake, going stale on a real safe-app change is the
    /// expensive one.
    @objc private func handleAppLifecycleChange(_ notification: Notification) {
        if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
           let bundleID = app.bundleIdentifier,
           !ContentGuardConfig.safeAppBundleIDs.contains(bundleID) {
            // Positively identified as an app whose launch/quit cannot
            // change the exclusion set - nothing to do.
            return
        }
        Task {
            do {
                try await refresh()
                delegate?.appScopeManagerDidUpdateScope(self)
            } catch {
                // Best-effort: on a transient SCShareableContent failure,
                // keep whatever excludedApplications/latestContent state we
                // already had rather than clearing it. A stale-but-nonempty
                // safe list is the safer failure mode here - it never
                // widens what gets excluded from capture, only narrows it
                // back toward "cover more, not less" if it's wrong.
            }
        }
    }
}
