// Closes Finder's Quick Look preview after a detection. The normal reaction
// (force-quit the frontmost app, main.swift) can't apply here: the preview
// is a Finder-owned floating window (see
// ContentGuardConfig.forceCaptureFloatingWindowBundleIDs) and Finder is on
// ContentGuardConfig.neverTerminateBundleIDs, so a detection inside Quick
// Look used to be logged and then do nothing - found live, 2026-11-04: the
// preview was scanned but never closed.
//
// Two steps, least disruptive first:
//   1. SIGKILL every QuickLookUIService process. That's the out-of-process
//      renderer that draws the preview's content into Finder's panel; same
//      user as the agent, so no privileges needed.
//   2. If a Finder floating window is still on screen after
//      closeVerifyDelaySeconds, force-quit Finder itself. The panel lives in
//      Finder's process, so this always closes it, and launchd relaunches
//      Finder straight away (same effect as `killall Finder`).

import AppKit

enum QuickLookCloser {
    private static let finderBundleID = "com.apple.finder"
    private static let closeVerifyDelaySeconds: TimeInterval = 1.0

    /// Whether `windowID` is a Finder floating window - the Quick Look
    /// preview. Used to attribute a detection from a per-window stream.
    static func isQuickLookWindow(_ windowID: CGWindowID) -> Bool {
        quickLookWindowIDs().contains(windowID)
    }

    /// Whether a Quick Look preview is on screen right now. Reads the live
    /// window list (CGWindowListCopyWindowInfo, synchronous) rather than
    /// AppScopeManager's last SCShareableContent snapshot, which can be up
    /// to a poll interval stale.
    static func isQuickLookOpen() -> Bool {
        !quickLookWindowIDs().isEmpty
    }

    /// Must be called on the main thread (NSRunningApplication is AppKit).
    static func close() {
        let killed = killQuickLookUIService()
        NSLog("ContentGuardAgent: closing Quick Look - killed \(killed) QuickLookUIService process(es)")

        DispatchQueue.main.asyncAfter(deadline: .now() + closeVerifyDelaySeconds) {
            guard isQuickLookOpen() else {
                NSLog("ContentGuardAgent: Quick Look closed")
                return
            }
            NSLog("ContentGuardAgent: Quick Look still open - force-quitting Finder (launchd relaunches it)")
            for finder in NSRunningApplication.runningApplications(withBundleIdentifier: finderBundleID) {
                finder.forceTerminate()
            }
        }
    }

    private static func quickLookWindowIDs() -> Set<CGWindowID> {
        let finderPIDs = Set(
            NSRunningApplication.runningApplications(withBundleIdentifier: finderBundleID)
                .map(\.processIdentifier)
        )
        guard !finderPIDs.isEmpty,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return [] }

        var ids = Set<CGWindowID>()
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t,
                  finderPIDs.contains(pid),
                  let layer = window[kCGWindowLayer as String] as? Int,
                  ContentGuardConfig.floatingWindowLayers.contains(layer),
                  let id = window[kCGWindowNumber as String] as? CGWindowID
            else { continue }
            ids.insert(id)
        }
        return ids
    }

    /// Returns how many processes were signalled. Same sysctl +
    /// proc_pidpath() approach as the daemon's ProcessEnumeration.swift,
    /// but KERN_PROC_UID so only this user's own processes are ever
    /// considered.
    private static func killQuickLookUIService() -> Int {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_UID, Int32(bitPattern: getuid())]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return 0 }
        var procList = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride)
        guard sysctl(&mib, u_int(mib.count), &procList, &size, nil, 0) == 0 else { return 0 }

        var killed = 0
        // 4 * MAXPATHLEN - PROC_PIDPATHINFO_MAXSIZE isn't importable into
        // Swift, see ProcessEnumeration.pidPathMaxSize.
        var pathBuffer = [CChar](repeating: 0, count: 4 * 1024)
        for proc in procList.prefix(size / MemoryLayout<kinfo_proc>.stride) {
            let pid = proc.kp_proc.p_pid
            guard pid > 0, proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count)) > 0 else { continue }
            guard (String(cString: pathBuffer) as NSString).lastPathComponent == "QuickLookUIService" else { continue }
            if kill(pid, SIGKILL) == 0 { killed += 1 }
        }
        return killed
    }
}
