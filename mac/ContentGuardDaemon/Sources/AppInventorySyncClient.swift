// Pushes AppInventoryScanner's local /Applications scan up to the Worker
// (POST /sync/app-inventory, worker/src/daemonSync.ts's
// handleAppInventorySync) - the opposite direction from
// SafeAppsSyncClient.swift, which pulls dashboard-approved state down.
// Same trust boundary though: the same daemon-sync token
// (ContentGuardPaths.daemonSyncTokenFile), same header
// (X-ContentGuard-Daemon-Token), same "missing token = nothing to sync
// yet, not an error" treatment.
//
// Runs on the daemon (root) for the same reason SafeAppsSyncClient does -
// this is the tamper-resistant anchor, and the scan itself needs to read
// every app under /Applications regardless of which user is logged in,
// which a root LaunchDaemon can do unconditionally.

import Foundation

final class AppInventorySyncClient {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.app-inventory-sync")
    private var timer: DispatchSourceTimer?
    private let log: (String) -> Void

    /// Same 15-minute cadence as SafeAppsSyncClient, same reasoning -
    /// installed apps don't change often enough for a shorter interval to
    /// buy anything real, and this matches the Worker's own Cron Trigger
    /// tick too.
    private let syncIntervalSeconds: TimeInterval = 15 * 60

    init(log: @escaping (String) -> Void) {
        self.log = log
    }

    func start() {
        // Scan and push once immediately, same "don't make a freshly
        // (re)started daemon wait 15 minutes" reasoning as
        // SafeAppsSyncClient.start().
        queue.async { [weak self] in self?.scanAndPush() }

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + syncIntervalSeconds, repeating: syncIntervalSeconds, leeway: .seconds(30))
        t.setEventHandler { [weak self] in self?.scanAndPush() }
        t.resume()
        timer = t
    }

    private func scanAndPush() {
        guard let token = readSyncToken() else {
            // Not configured yet - see SafeAppsSyncClient's identical
            // guard for why this stays silent rather than logging on
            // every tick.
            return
        }

        let apps = AppInventoryScanner.scan(log: log)
        guard !apps.isEmpty else {
            // An empty /Applications scan is almost certainly a bug
            // (permissions, a moved directory) rather than a real state
            // of this Mac - and the Worker's own replaceAppInventory
            // treats an empty apps list as "wipe the table" for exactly
            // that reason (see db.ts's own guard). Never send it.
            log("AppInventoryScanner: scan returned zero apps - skipping this sync rather than risk wiping the dashboard's table")
            return
        }

        guard let url = URL(string: "\(ContentGuardIdentifiers.panelBaseURL)/sync/app-inventory") else {
            log("AppInventorySyncClient: malformed panel URL - this is a build-time bug, not a runtime condition")
            return
        }

        let payload = AppInventorySyncPayload(apps: apps.map {
            AppInventorySyncPayload.App(bundle_id: $0.bundleId, name: $0.name, team_id: $0.teamId, path: $0.path)
        })
        guard let body = try? JSONEncoder().encode(payload) else {
            log("AppInventorySyncClient: failed to encode scan results - this is a build-time bug, not a runtime condition")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "X-ContentGuard-Daemon-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 30

        let task = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self else { return }
            if let error {
                self.log("AppInventorySyncClient: push failed: \(error) - will retry next tick")
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode
                self.log("AppInventorySyncClient: unexpected response (status=\(status.map(String.init) ?? "none")) - will retry next tick")
                return
            }
            // Nothing to write locally - unlike SafeAppsSyncClient, this
            // is a pure push with no on-disk cache for anything else on
            // this Mac to read. Success just means the dashboard's table
            // is current; nothing more to do until the next tick.
        }
        task.resume()
    }

    /// Same token file, same trimming reasoning, as
    /// SafeAppsSyncClient.readSyncToken() - deliberately duplicated
    /// rather than shared, to keep these two clients independently
    /// readable (see SafeAppsSyncClient's own header for why they're
    /// separate classes at all).
    private func readSyncToken() -> String? {
        guard let raw = try? String(contentsOfFile: ContentGuardPaths.daemonSyncTokenFile, encoding: .utf8) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Wire shape for POST /sync/app-inventory - matches
/// worker/src/daemonSync.ts's handleAppInventorySync request body
/// exactly (snake_case field names kept verbatim, not remapped to Swift
/// convention, so this struct is a direct, obvious mirror of the JSON
/// the Worker actually parses).
private struct AppInventorySyncPayload: Encodable {
    struct App: Encodable {
        let bundle_id: String
        let name: String?
        let team_id: String?
        let path: String
    }
    let apps: [App]
}
