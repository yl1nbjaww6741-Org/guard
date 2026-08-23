// Shared sysctl-based process enumeration, used by both RunningAppCheck
// (HeartbeatMonitor.swift, deciding whether a risky-looking app justifies
// failing the whole screen closed) and AppLockManager (deciding whether a
// specific locked-out app is trying to relaunch). Extracted here rather than
// duplicated: both need the same "pid -> real executable path" mapping, and
// the daemon has no GUI session to get it from NSWorkspace the way the agent
// does (see FallbackCover.swift's doc comment on why the daemon can't use
// NSWorkspace at all) - sysctl(KERN_PROC_ALL) + proc_pidpath() is what's
// available to root without one.

import Foundation

enum ProcessEnumeration {
    /// Real value of the C macro PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN,
    /// i.e. 4 * 1024 - stable across macOS versions, unlikely to ever
    /// change). Defined locally rather than using the SDK macro directly:
    /// the macOS 26.5 SDK marks it "unavailable: structure not supported"
    /// for Swift import specifically (confirmed via a real build error,
    /// not assumed) - the underlying value itself is unaffected, just not
    /// reachable through Swift's C interop anymore.
    private static let pidPathMaxSize = 4 * 1024

    /// Enumerates running processes via sysctl(KERN_PROC_ALL) - available to
    /// root without any GUI session, unlike NSWorkspace.runningApplications.
    static func runningProcesses() -> [(pid: Int32, path: String)] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return [] }

        let entryCount = size / MemoryLayout<kinfo_proc>.stride
        var procList = [kinfo_proc](repeating: kinfo_proc(), count: entryCount)
        guard sysctl(&mib, u_int(mib.count), &procList, &size, nil, 0) == 0 else { return [] }

        var results: [(pid: Int32, path: String)] = []
        for proc in procList {
            let pid = proc.kp_proc.p_pid
            guard pid > 0 else { continue }
            var pathBuffer = [CChar](repeating: 0, count: pidPathMaxSize)
            let len = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
            if len > 0 {
                results.append((pid: pid, path: String(cString: pathBuffer)))
            }
        }
        return results
    }
}
