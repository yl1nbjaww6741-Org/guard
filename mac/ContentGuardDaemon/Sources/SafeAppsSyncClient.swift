// Fetches the dashboard-approved safe-app-bundle-ID list from the Worker
// (GET /sync/safe-apps, worker/src/daemonSync.ts) and caches it to
// ContentGuardPaths.safeAppsSyncFile for the agent to read. This is the
// first and only network call anything on this Mac makes to this
// project's own infrastructure, deliberately confined to the daemon
// (root, the tamper anchor - see this daemon's own main.swift header)
// rather than the agent (runs as the logged-in user, more exposed to
// same-user tampering) - confirmed as the right tradeoff before building
// this, not assumed (Shared/Config.swift's header had deliberately kept
// both processes network-free until now).
//
// Fails toward the cached file, never toward the network: a Worker
// outage, a DNS blip, an expired/missing token - none of these clear or
// corrupt the existing cache. The cache is only ever overwritten by a
// genuinely successful fetch of well-formed JSON (see fetchAndCache()).
// The compiled ContentGuardConfig.safeAppBundleIDs baseline in
// AppScopeManager.swift is the fallback of last resort if this file has
// never been written at all - this client only ever ADDS to that
// baseline, never replaces it.

import Foundation

final class SafeAppsSyncClient {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.safe-apps-sync")
    private var timer: DispatchSourceTimer?
    private let log: (String) -> Void

    /// 15 minutes - matches the Worker's own Cron Trigger cadence
    /// (worker/wrangler.toml's [triggers] block: "*/15 * * * *"). Polling
    /// faster than the ratchet's own apply tick can't see a newly-applied
    /// change any sooner than that tick actually runs, so there's no
    /// latency win in a shorter interval, only wasted requests.
    private let syncIntervalSeconds: TimeInterval = 15 * 60

    init(log: @escaping (String) -> Void) {
        self.log = log
    }

    func start() {
        // Fetch once immediately - don't make a freshly (re)started
        // daemon, or the agent it feeds, wait a full 15 minutes for its
        // first sync.
        queue.async { [weak self] in self?.fetchAndCache() }

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + syncIntervalSeconds, repeating: syncIntervalSeconds, leeway: .seconds(30))
        t.setEventHandler { [weak self] in self?.fetchAndCache() }
        t.resume()
        timer = t
    }

    private func fetchAndCache() {
        guard let token = readSyncToken() else {
            // Not configured yet (see ContentGuardPaths.daemonSyncTokenFile's
            // doc comment on manual provisioning) - not an error, just
            // nothing to sync. AppScopeManager's own fallback (compiled
            // baseline alone) is exactly correct in this state, so this
            // stays silent rather than logging on every 15-minute tick
            // for what could be a deliberately-unconfigured install.
            return
        }

        guard let url = URL(string: "\(ContentGuardIdentifiers.panelBaseURL)/sync/safe-apps") else {
            log("SafeAppsSyncClient: malformed panel URL - this is a build-time bug, not a runtime condition")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(token, forHTTPHeaderField: "X-ContentGuard-Daemon-Token")
        request.timeoutInterval = 30

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            if let error {
                self.log("SafeAppsSyncClient: fetch failed: \(error) - keeping existing cache")
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data else {
                let status = (response as? HTTPURLResponse)?.statusCode
                self.log("SafeAppsSyncClient: unexpected response (status=\(status.map(String.init) ?? "none")) - keeping existing cache")
                return
            }
            // Validate before ever touching the cache file - a
            // successful HTTP fetch of malformed/unexpected JSON must
            // never overwrite a good cache with garbage. Decoding into
            // the real SafeAppsSyncFile shape (not just checking it
            // parses as *some* JSON) also catches a wrong-shaped 200 -
            // e.g. some infra returning an HTML error page with a 200
            // status - since bundle_ids specifically has to decode as
            // [String].
            guard (try? JSONDecoder().decode(SafeAppsSyncFile.self, from: data)) != nil else {
                self.log("SafeAppsSyncClient: response wasn't the expected {bundle_ids:[...]} shape - keeping existing cache")
                return
            }
            self.writeCache(data)
        }
        task.resume()
    }

    /// Writes the already-validated raw response bytes verbatim - no
    /// re-encode step needed, the successful decode above already proved
    /// these bytes are exactly the shape AppScopeManager expects.
    /// Write-to-temp-then-replaceItemAt(_:withItemAt:) rather than a
    /// direct write, so a reader on the agent side (polling on its own
    /// timer, no coordination with this one) never observes a partially-
    /// written file - replaceItemAt is atomic, a plain Data.write(to:) at
    /// the final path would not be for a reader racing the write.
    private func writeCache(_ data: Data) {
        let path = ContentGuardPaths.safeAppsSyncFile
        let tmpPath = path + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmpPath), options: .atomic)
            // World-readable deliberately - see
            // ContentGuardPaths.safeAppsSyncFile's own doc comment for
            // why: the agent runs as the logged-in user, not root, and
            // has to be able to read this with no IPC round-trip. Still
            // root-owned (by virtue of this process running as root) and
            // therefore not writable by anything but the daemon itself -
            // that ownership, not the file's readability, is the actual
            // security property this depends on.
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tmpPath)
            _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmpPath))
        } catch {
            log("SafeAppsSyncClient: failed to write cache: \(error)")
        }
    }

    /// Trailing whitespace/newline stripped since this file is meant to
    /// be hand-created with a plain text editor as part of manual
    /// provisioning (see ContentGuardPaths.daemonSyncTokenFile's doc
    /// comment), which commonly leaves a trailing newline that would
    /// otherwise become part of the header value sent on every request.
    private func readSyncToken() -> String? {
        guard let raw = try? String(contentsOfFile: ContentGuardPaths.daemonSyncTokenFile, encoding: .utf8) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
