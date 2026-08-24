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

    /// Dashboard-adjustable additions on top of the compiled
    /// ContentGuardConfig.safeAppBundleIDs baseline - see
    /// ContentGuardPaths.safeAppsSyncFile's doc comment for where this
    /// comes from (SafeAppsSyncClient, daemon-side) and effectiveSafeAppBundleIDs
    /// below for how the two combine. Starts empty, not pre-populated
    /// from ContentGuardConfig - only ever grows from what
    /// reloadSyncedSafeApps() actually reads and successfully parses.
    private var syncedSafeAppBundleIDs: Set<String> = []
    private var safeAppsSyncPollTimer: DispatchSourceTimer?

    /// The compiled baseline, unioned with whatever's been synced from
    /// the dashboard. Deliberately a union, never a replacement - see
    /// ContentGuardPaths.safeAppsSyncFile's doc comment: the synced list
    /// can only ever ADD to what's excluded from capture, never remove
    /// from the compiled baseline (that would require a recompile, by
    /// design - the whole reason the baseline is a Swift constant and
    /// not itself dashboard-managed).
    private var effectiveSafeAppBundleIDs: Set<String> {
        ContentGuardConfig.safeAppBundleIDs.union(syncedSafeAppBundleIDs)
    }

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
        // Best-effort synchronous read at init - so the very first
        // refresh() call (CaptureManager.start()) already has whatever
        // was cached from a previous run, rather than starting from the
        // compiled baseline alone and only picking up synced entries on
        // the first poll tick up to 5 minutes later.
        _ = reloadSyncedSafeApps()
        startSafeAppsSyncPoll()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        safeAppsSyncPollTimer?.cancel()
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
            effectiveSafeAppBundleIDs.contains(app.bundleIdentifier)
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
           !effectiveSafeAppBundleIDs.contains(bundleID) {
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

    // MARK: - Dashboard-synced safe apps

    /// Polled on a timer rather than filesystem-event-watched -
    /// deliberately the simpler mechanism: ContentGuardPaths.safeAppsSyncFile
    /// changes at most once per SafeAppsSyncClient's own 15-minute sync
    /// interval (daemon-side), so there's no real latency cost to a
    /// 5-minute poll here, and it avoids the edge cases of watching for
    /// an atomic rename-replace write (a plain DispatchSource file watch
    /// doesn't reliably survive that without extra re-arming logic).
    private func startSafeAppsSyncPoll() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 300, repeating: 300, leeway: .seconds(30))
        t.setEventHandler { [weak self] in
            guard let self, self.reloadSyncedSafeApps() else { return }
            // Same refresh-and-notify path as an app launch/quit -
            // CaptureManager needs to rebuild its SCContentFilter(s)
            // either way, since the exclusion set actually changed.
            Task {
                do {
                    try await self.refresh()
                    self.delegate?.appScopeManagerDidUpdateScope(self)
                } catch {
                    // Same best-effort reasoning as handleAppLifecycleChange's
                    // catch block above.
                }
            }
        }
        t.resume()
        safeAppsSyncPollTimer = t
    }

    /// Reads and parses ContentGuardPaths.safeAppsSyncFile, updating
    /// syncedSafeAppBundleIDs if - and only if - the parsed content is
    /// both well-formed AND actually different from what's already held.
    /// Returns whether anything changed (callers use this to decide
    /// whether a rebuild is even worth triggering).
    ///
    /// Fails toward the LAST successfully parsed synced set, not toward
    /// the compiled baseline alone, on a read/parse failure - same
    /// reasoning handleAppLifecycleChange's catch block above already
    /// documents for a transient SCShareableContent failure: a stale-
    /// but-previously-valid synced set never widens what gets excluded
    /// beyond what was already a deliberate, ratchet-approved admin
    /// decision on the dashboard - it only risks being briefly out of
    /// date. Only the very first read (no file yet, or never
    /// successfully parsed even once this run) leaves
    /// syncedSafeAppBundleIDs empty, which - unioned with the compiled
    /// baseline in effectiveSafeAppBundleIDs - is exactly the compiled
    /// baseline alone, the correct state when nothing has ever synced.
    @discardableResult
    private func reloadSyncedSafeApps() -> Bool {
        guard let data = FileManager.default.contents(atPath: ContentGuardPaths.safeAppsSyncFile),
              let decoded = try? JSONDecoder().decode(SafeAppsSyncFile.self, from: data)
        else {
            return false
        }
        let newSet = Set(decoded.bundle_ids)
        guard newSet != syncedSafeAppBundleIDs else { return false }
        syncedSafeAppBundleIDs = newSet
        return true
    }
}
