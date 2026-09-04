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
import os
import ScreenCaptureKit

/// os.Logger with explicit `privacy: .public`, not NSLog - same reasoning
/// as CaptureManager.swift's own logger (see that file's header comment):
/// NSLog's output for this process comes back fully redacted
/// ("(Foundation) <private>") under `log show`/`log stream`, even for a
/// message with no dynamic content. Added 2026-09-04 specifically to
/// answer a real, live "why does capture keep resuming" question that
/// the existing appScopeManagerNonSafeAppIsRunning log line (CaptureManager.swift,
/// "non-whitelisted app now running - resuming capture") couldn't answer
/// on its own - it says THAT something wasn't safe, never WHICH bundle
/// ID, so diagnosing a real report of rapid pause/resume cycling meant
/// guessing instead of reading a log line.
private let logger = Logger(subsystem: "com.contentguard.agent", category: "AppScopeManager")

protocol AppScopeManagerDelegate: AnyObject {
    /// Called whenever the set of excluded applications changes (an app in
    /// the safe list launched or quit) - CaptureManager should rebuild its
    /// SCContentFilter(s) in response, since SCContentFilter is immutable
    /// once created.
    func appScopeManagerDidUpdateScope(_ manager: AppScopeManager)

    /// Every currently-running regular application (see
    /// allRunningRegularAppsAreSafe()'s own doc comment for exactly what
    /// "regular" means and why) is on the safe list right now.
    /// CaptureManager should pause capture entirely - the same battery
    /// reasoning as pausing on display sleep, just triggered by what's
    /// running instead of display power state. No content is at risk
    /// either way: capture is turned off, but a safe-listed app's
    /// windows were never scanned in the first place even while capture
    /// was on, so this changes nothing about what gets seen, only
    /// whether the pipeline bothers running while there's nothing
    /// unwhitelisted to catch.
    func appScopeManagerAllRunningAppsAreSafe(_ manager: AppScopeManager)

    /// The reverse - at least one currently-running regular application
    /// is NOT on the safe list (a new one just launched, or the
    /// dashboard-synced whitelist just narrowed under an app that was
    /// already running). CaptureManager should resume capture
    /// immediately if it was paused for this reason.
    func appScopeManagerNonSafeAppIsRunning(_ manager: AppScopeManager)
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
        // NSWorkspace.did{Launch,Terminate}ApplicationNotification post to
        // NSWorkspace.shared.notificationCenter, NOT NotificationCenter.default
        // (Apple's own docs for NSWorkspace say so explicitly). Registering
        // on .default here was the real bug behind capture-pause gating
        // never firing on a real Mac: a live, log-stream-attached test
        // (open + quit Calculator) produced zero output even from an
        // unconditional diagnostic NSLog at the very top of
        // handleAppLifecycleChange, despite confirming via ps/strings that
        // the running process was freshly built and did contain that log
        // line - the observer was just never being called. Note
        // CaptureManager.swift's NSWorkspace.didWake/screensDidSleep/
        // screensDidWakeNotification registrations are left on .default
        // deliberately - those are a different notification family and are
        // independently confirmed working (the "unlock twice" bug required
        // them to actually fire).
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(handleAppLifecycleChange),
            name: NSWorkspace.didLaunchApplicationNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
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
        NSWorkspace.shared.notificationCenter.removeObserver(self)
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

    /// The complement of safeAppWindows(): every on-screen window NOT
    /// belonging to a safe-listed app, as of the last refresh(). Used by
    /// CaptureManager to give each one its own dedicated, higher-
    /// resolution SCStream (SCContentFilter(desktopIndependentWindow:))
    /// alongside the existing whole-display capture - see
    /// CaptureManager.swift's riskyWindowStreams for the real gap this
    /// closes: a small window on a large display gets diluted almost to
    /// nothing once the whole-display frame is downscaled to
    /// ContentGuardConfig.maxCaptureDimension, exactly the gap a user
    /// shrinking a risky app's window would exploit (the reported concern
    /// that motivated this: QuickTime, deliberately made small so the
    /// blocker "wouldn't see it") - the classifier still technically sees
    /// something, just at a resolution it can't use well. Not yet
    /// confirmed live on the real Mac, same as everything else in this
    /// file added without hardware to test against.
    ///
    /// A window with no resolvable owningApplication is included here
    /// (fails toward MORE dedicated capture, not less) - the mirror image
    /// of safeAppWindows()'s own nil-owner handling above, which fails
    /// toward NOT excluding such a window from the whole-display path
    /// either. Deliberately NOT scoped to .regular-activation-policy apps
    /// the way allRunningRegularAppsAreSafe() is - that narrower scope
    /// exists specifically to make "is anything risky running at all"
    /// reachable as a true/false answer; this method only decides which
    /// of possibly-several already-on-screen windows get extra capture
    /// attention, so there's no equivalent reason to narrow it, and real
    /// cost (a missed window) to narrowing it wrongly.
    func riskyAppWindows() -> [SCWindow] {
        guard let latestContent else { return [] }
        let safeBundleIDs = effectiveSafeAppBundleIDs
        return latestContent.windows.filter { window in
            guard let owner = window.owningApplication else { return true }
            return !safeBundleIDs.contains(owner.bundleIdentifier)
        }
    }

    /// Whether any currently on-screen window belongs to one of
    /// ContentGuardConfig.forceCaptureOnBundleIDs - see that constant's
    /// own doc comment for why this is a deliberately narrow, explicit
    /// check rather than reusing riskyAppWindows() above for the same
    /// purpose (a real regression found live: riskyAppWindows() is
    /// correctly broad for ITS OWN job of giving every non-safe window a
    /// dedicated stream, but that same breadth means it's essentially
    /// never empty on a real Mac session - ordinary system chrome like
    /// the Dock or Control Center isn't owned by a safe-listed app
    /// either - so using it here would defeat the pause-for-battery
    /// optimization outright, not just close its real blind spot).
    /// No owningApplication is NOT treated as a match here, unlike
    /// riskyAppWindows()'s own nil-owner handling - this check exists to
    /// force capture on for one specific, named process, not to fail
    /// toward more capture in general the way that broader method does.
    /// Edge-triggered, same reasoning as allRunningRegularAppsAreSafe()'s
    /// own lastLoggedUnsafeBundleIDs - this is called on every
    /// CaptureManager poll tick (every captureIntervalSeconds), so
    /// logging unconditionally would mean a line every few seconds for
    /// as long as this stays true.
    private var lastLoggedForceCaptureMatch = false

    func hasForceCaptureWindow() -> Bool {
        guard let latestContent else { return false }
        let forceCaptureBundleIDs = ContentGuardConfig.forceCaptureOnBundleIDs
        let matches = latestContent.windows.filter { window in
            guard let owner = window.owningApplication else { return false }
            return forceCaptureBundleIDs.contains(owner.bundleIdentifier)
        }
        let result = !matches.isEmpty
        if result != lastLoggedForceCaptureMatch {
            lastLoggedForceCaptureMatch = result
            if result {
                // Diagnostic added 2026-09-04 to answer a real, live
                // question this function's own doc comment couldn't:
                // does a match here only ever happen while the actual
                // screenshot review panel is genuinely open, or does
                // com.apple.screencaptureui keep some other, persistent
                // window registered that would force capture on far more
                // often than intended? Frame size is the key detail - a
                // real review panel is a sizeable, visible UI element;
                // a stale/placeholder window would likely be near-zero.
                let details = matches.map { "title=\($0.title ?? "nil") frame=\($0.frame)" }.joined(separator: "; ")
                logger.log("force-capture window match: \(details, privacy: .public)")
            } else {
                logger.log("force-capture window match cleared")
            }
        }
        return result
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
        let bundleID = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier

        // Window-exclusion rebuild stays gated to safe-listed apps only -
        // see this method's own doc comment above for the real battery
        // cost unconditionally refreshing here used to have. A non-safe
        // app's launch/quit can't add or remove anything from
        // excludedApplications either way.
        if bundleID == nil || effectiveSafeAppBundleIDs.contains(bundleID!) {
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

        // Capture-pause eligibility, unlike the rebuild above, is NOT
        // gated to safe-listed apps - deliberately the opposite filter.
        // A non-safe app launching is exactly the signal that has to
        // resume capture, and a non-safe app being the last one running
        // when it quits is exactly the signal that allows pausing.
        // Evaluated on every launch/quit, unconditionally.
        evaluateCapturePauseEligibility()
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
            // The whitelist itself just changed, independent of any app
            // launching/quitting - a dashboard addition could newly make
            // "everything running is safe" true, or a removal could make
            // it newly false, without a single process transition to
            // hang either off of.
            self.evaluateCapturePauseEligibility()
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

    // MARK: - Capture-pause eligibility (nothing risky running)

    /// Computes whether every currently-running regular application is on
    /// the safe list right now and informs the delegate accordingly - see
    /// appScopeManagerAllRunningAppsAreSafe/appScopeManagerNonSafeAppIsRunning's
    /// own doc comments for what CaptureManager does with each. Called
    /// unconditionally on every relevant change (an app launching/quitting,
    /// the synced safe-app list changing) rather than only on an actual
    /// transition - CaptureManager's own pause-flag guards already no-op a
    /// redundant call in either direction, so there's no reason to
    /// duplicate that bookkeeping here too.
    ///
    /// Public, not private like most of this class's internals - the very
    /// first evaluation has to happen after CaptureManager has actually
    /// set itself as this object's delegate. That wiring doesn't exist
    /// yet inside AppScopeManager's own init() (CaptureManager is
    /// constructed afterward, in main.swift, and sets `appScopeManager.delegate
    /// = self` inside its own init) - CaptureManager.start() calls this
    /// explicitly right after its own initial refresh() instead, once the
    /// delegate is guaranteed to be wired.
    func evaluateCapturePauseEligibility() {
        if allRunningRegularAppsAreSafe() {
            delegate?.appScopeManagerAllRunningAppsAreSafe(self)
        } else {
            delegate?.appScopeManagerNonSafeAppIsRunning(self)
        }
    }

    /// True if every currently-running REGULAR application - NSRunningApplication.activationPolicy
    /// == .regular, the same scope Activity Monitor's own "Windowed
    /// Processes" view uses, a real app a user could actually be looking
    /// at - is on effectiveSafeAppBundleIDs.
    ///
    /// Deliberately scoped to .regular apps, not
    /// NSWorkspace.runningApplications in full: that full list includes
    /// every background helper/menu-bar-only/XPC-service process the
    /// system runs continuously (iCloud helpers, Spotlight, countless
    /// others), which would make "nothing risky running" essentially
    /// unreachable in practice - not a deliberate safety margin, an
    /// accident of using the wrong API for what this check actually needs
    /// to mean.
    ///
    /// Checks process EXISTENCE, not window visibility, and that
    /// distinction is the entire reason this is safe to gate capture on
    /// at all - see the design discussion this came from. A window
    /// merely becoming visible has no reliable system notification behind
    /// it (an already-running app un-minimizing, or a background window on
    /// a second display becoming un-occluded, fires nothing), so gating on
    /// that would create a real detection gap. A process launching or
    /// quitting always does fire a notification
    /// (handleAppLifecycleChange above already depends on this), so
    /// gating on process existence instead has no equivalent gap: as long
    /// as a non-safe app's process exists at all - regardless of whether
    /// it currently has any window open - capture stays on.
    ///
    /// A nil bundleIdentifier fails closed (treated as non-safe) - the
    /// same "when in doubt, don't shed" policy as every other prefilter in
    /// this project.
    ///
    /// Real gap found live, 2026-09-04, worth flagging directly on this
    /// method since it's the actual root cause: "regardless of whether it
    /// currently has any window open" above is true for .regular apps,
    /// but says nothing about a NON-regular process's window - and a
    /// non-regular process can absolutely have a window worth protecting.
    /// The macOS screenshot review panel/editor is exactly that case: it
    /// never gets a Dock icon (not .regular), so it's invisible to this
    /// method entirely - "nothing risky running" can stay true with that
    /// window fully open, if every actual .regular app happens to be
    /// safe-listed. Confirmed live: no purple screen-recording indicator
    /// appeared at all with the review window open and only Terminal
    /// (safe-listed) also running - capture was genuinely paused.
    ///
    /// Not fixed here - this method's own narrow scope (.regular apps
    /// only) is still correct for what IT'S supposed to answer. Fixed
    /// instead in CaptureManager.reconcileRiskyWindowStreams(), via
    /// hasForceCaptureWindow() below - deliberately NOT riskyAppWindows()
    /// below, despite that method also looking at windows regardless of
    /// app type: a first attempt did exactly that and found a real
    /// regression instead of a fix - riskyAppWindows() is correctly broad
    /// for its own job (every non-safe window gets a dedicated stream),
    /// but that breadth means it's essentially never empty on a real Mac
    /// session (ordinary system chrome - the Dock, Control Center - isn't
    /// owned by a safe-listed app either), which defeated this whole
    /// pause optimization outright rather than closing its real, narrow
    /// blind spot. hasForceCaptureWindow() checks a short, explicit list
    /// (ContentGuardConfig.forceCaptureOnBundleIDs) instead - that
    /// function now runs even while paused for this reason specifically,
    /// so it can see past this method's own blind spot and trigger a
    /// resume, without also catching everything else on screen.
    /// Logs the actual offending bundle ID(s) whenever the unsafe set
    /// CHANGES from the last time this logged - not on every call. This
    /// runs on every evaluateCapturePauseEligibility() invocation (both
    /// app launch/quit and, since 2026-09-04, CaptureManager's own poll),
    /// so logging unconditionally here would mean a line every few
    /// seconds for as long as anything legitimately non-safe stays
    /// running - the common case, not the exceptional one. Only the
    /// transition is diagnostically interesting: "a new/different set of
    /// apps just became the reason capture is on."
    private var lastLoggedUnsafeBundleIDs: Set<String> = []

    private func allRunningRegularAppsAreSafe() -> Bool {
        let safe = effectiveSafeAppBundleIDs
        let unsafeBundleIDs = Set(
            NSWorkspace.shared.runningApplications
                .filter { $0.activationPolicy == .regular }
                // nil bundleIdentifier fails closed (treated as unsafe) -
                // represented here as the literal string "(no bundle ID)"
                // so it still shows up in the logged set rather than
                // silently disappearing from it.
                .compactMap { app -> String? in
                    let bundleID = app.bundleIdentifier ?? "(no bundle ID)"
                    return safe.contains(bundleID) ? nil : bundleID
                }
        )
        if unsafeBundleIDs != lastLoggedUnsafeBundleIDs {
            lastLoggedUnsafeBundleIDs = unsafeBundleIDs
            if unsafeBundleIDs.isEmpty {
                logger.log("all running regular apps are now safe-listed")
            } else {
                logger.log("non-safe-listed regular app(s) running: \(unsafeBundleIDs.sorted().joined(separator: ", "), privacy: .public)")
            }
        }
        return unsafeBundleIDs.isEmpty
    }
}
