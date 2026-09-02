// Scans /Applications for real code-signing identity - specifically each
// app's Team ID, via the Security framework, run locally on this Mac.
// This is the one piece of information SimpleMDM's own inventory API
// can never supply (see worker/migrations/0008_app_inventory.sql's own
// comment for the full "why"), and it's what AppInventorySyncClient.swift
// pushes up so the dashboard can offer a real, working per-app Allow/Block
// button - the actual prerequisite for switching Santa to LOCKDOWN mode.
//
// Scoped to /Applications only, not a recursive filesystem walk and not
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
    /// Runs synchronously - a plain-file-system enumeration plus one
    /// SecStaticCodeCreateWithPath call per app, both fast local
    /// operations. Called from AppInventorySyncClient's own background
    /// queue, never the main thread, same "don't block anything on this"
    /// treatment as everything else this daemon does off the main run loop.
    static func scan(log: @escaping (String) -> Void) -> [ScannedApp] {
        let appsDir = "/Applications"
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
