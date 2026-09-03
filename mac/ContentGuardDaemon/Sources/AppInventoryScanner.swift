// Scans /Applications AND every real user's own ~/Applications for real
// code-signing identity - specifically each app's Team ID, via the
// Security framework, run locally on this Mac. This is the one piece of
// information SimpleMDM's own inventory API can never supply (see
// worker/migrations/0008_app_inventory.sql's own comment for the full
// "why"), and it's what AppInventorySyncClient.swift pushes up so the
// dashboard can offer a real, working per-app Allow/Block button - the
// actual prerequisite for switching Santa to LOCKDOWN mode.
//
// ~/Applications is a REAL gap this had at first, found live: several
// apps (Gemini, O+Connect, Zoom, on the real Mac) install there instead
// of the system-wide /Applications - some installers default to it,
// some are explicitly "install for me only". Missing it entirely would
// mean those apps could never get a real ALLOWLIST rule, so they'd stay
// hard-blocked the moment LOCKDOWN goes live - exactly the outcome this
// whole feature exists to prevent. Discovered by enumerating /Users/*
// (skipping non-account entries like "Shared") rather than a proper
// Open Directory lookup - a real simplification, not a guess: this
// project already treats "one real Mac, one real account" as a settled
// assumption elsewhere (schema.sql's dashboard_auth comment,
// DEFAULT_SIMPLEMDM_DEVICE_ID), and /Users/<name> is where a standard,
// non-mobile-account macOS home directory actually lives.
//
// Neither location is a recursive filesystem walk, and neither includes
// /System/Applications - third-party, user-installed apps are the only
// ones that ever need an explicit Team ID ALLOWLIST rule under LOCKDOWN;
// Apple's own platform binaries (no real Team ID at all, signed by
// Apple's own internal cert) run under LOCKDOWN with no rule needed,
// confirmed before this was built rather than assumed - see this
// project's own Santa LOCKDOWN research. Scanning them anyway would only
// add rows this dashboard's App Inventory table would show as "no Team
// ID" and nothing else - noise, not signal.

import Foundation
import Security

struct ScannedApp {
    let bundleId: String
    let name: String?
    let teamId: String?
    let path: String
}

enum AppInventoryScanner {
    /// Runs synchronously - plain file-system enumeration plus one
    /// SecStaticCodeCreateWithPath call per app, all fast local
    /// operations. Called from AppInventorySyncClient's own background
    /// queue, never the main thread, same "don't block anything on this"
    /// treatment as everything else this daemon does off the main run loop.
    static func scan(log: @escaping (String) -> Void) -> [ScannedApp] {
        var results: [ScannedApp] = []
        var seenBundleIds: Set<String> = []
        for dir in candidateDirectories(log: log) {
            for app in scanDirectory(dir, log: log) {
                // A bundle ID could genuinely appear in more than one
                // scanned directory (e.g. the same app installed both
                // system-wide and, from an older install, still present
                // under a user's own ~/Applications) - first one found
                // wins, same "one row per bundle ID" primary-key
                // constraint app_inventory itself already enforces, so
                // this dedup happens locally instead of letting the
                // Worker's own batch upsert silently pick whichever one
                // happened to be last in the array.
                guard seenBundleIds.insert(app.bundleId).inserted else { continue }
                results.append(app)
            }
        }
        return results
    }

    /// /Applications, plus every real account's own ~/Applications (see
    /// this file's own header for why the latter matters) - built by
    /// enumerating /Users rather than hardcoded to one account name, so
    /// this doesn't go stale if the account name on this Mac ever
    /// changes. "Shared" is a real, non-account special folder under
    /// /Users on every macOS install - explicitly excluded rather than
    /// just filtered by "has no Applications subfolder", so it reads as
    /// a deliberate exclusion, not a coincidence of this Mac's current
    /// state.
    private static func candidateDirectories(log: @escaping (String) -> Void) -> [String] {
        var dirs = ["/Applications"]
        guard let accounts = try? FileManager.default.contentsOfDirectory(atPath: "/Users") else {
            log("AppInventoryScanner: couldn't list /Users - skipping per-user ~/Applications scan")
            return dirs
        }
        for account in accounts where account != "Shared" && !account.hasPrefix(".") {
            let userAppsDir = "/Users/\(account)/Applications"
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: userAppsDir, isDirectory: &isDir), isDir.boolValue {
                dirs.append(userAppsDir)
            }
        }
        return dirs
    }

    private static func scanDirectory(_ appsDir: String, log: @escaping (String) -> Void) -> [ScannedApp] {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: appsDir) else {
            log("AppInventoryScanner: couldn't list \(appsDir)")
            return []
        }

        var results: [ScannedApp] = []
        for entry in entries where entry.hasSuffix(".app") {
            let appPath = "\(appsDir)/\(entry)"
            guard let bundle = Bundle(path: appPath), let bundleId = bundle.bundleIdentifier else {
                // No CFBundleIdentifier at all - not a real app bundle
                // (or a malformed one); nothing usable to report, skip
                // rather than send a row with no primary key.
                continue
            }
            let name = (bundle.infoDictionary?["CFBundleName"] as? String)
                ?? (bundle.infoDictionary?["CFBundleDisplayName"] as? String)
            let teamId = teamIdentifier(forAppAt: appPath)
            results.append(ScannedApp(bundleId: bundleId, name: name, teamId: teamId, path: appPath))
        }
        return results
    }

    /// The real Security framework calls - verified against a known-
    /// working example (not guessed) before this was written: create a
    /// static code reference for the app's own path, ask for its signing
    /// info, pull the Team ID out of that dictionary. Returns nil for an
    /// unsigned/ad-hoc-signed app or one signed with no Team ID at all
    /// (Apple's own platform binaries) - a nil here is a normal, expected
    /// outcome, not a failure to log every time.
    private static func teamIdentifier(forAppAt path: String) -> String? {
        var staticCode: SecStaticCode?
        let url = URL(fileURLWithPath: path)
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
              let code = staticCode else {
            return nil
        }

        var infoCFDict: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCFDict) == errSecSuccess,
              let infoDict = infoCFDict as? [String: Any] else {
            return nil
        }

        return infoDict[kSecCodeInfoTeamIdentifier as String] as? String
    }
}
