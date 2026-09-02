-- Real per-app code-signing inventory, reported by ContentGuardDaemon
-- itself (AppInventoryScanner.swift, daemon-side) via POST
-- /sync/app-inventory (daemonSync.ts), gated by the same
-- CONTENTGUARD_DAEMON_SYNC_TOKEN already used for GET /sync/safe-apps -
-- same trust boundary, no new secret needed.
--
-- Why this table exists at all: handleListInstalledSoftware's own
-- installed-apps rows always carry identifier: null, rule_type: null
-- (see softwareApi.ts's own comment) - SimpleMDM's inventory API has no
-- code-signing data whatsoever, so the dashboard's existing per-app
-- Allow/Block buttons there have never actually been reachable. Only the
-- Mac itself can get a real Team ID (via the Security framework's
-- SecCodeCopySigningInformation, run locally against each installed
-- .app), so this table is deliberately fed by the daemon's own local
-- scan, not by SimpleMDM's API at all - a completely separate data path
-- from software_packages/handleListInstalledSoftware above.
--
-- The real point of this table: making Santa LOCKDOWN mode practical.
-- LOCKDOWN is default-deny (see profiles/santa-config.mobileconfig's
-- ClientMode comment) - before switching to it, every app someone
-- actually uses needs a real ALLOWLIST rule first, and doing that one
-- codesign -dv lookup at a time for every installed app doesn't scale.
-- This table is what lets the dashboard offer a real, working "Allow"
-- button (and a bulk "allow everything currently installed" action) per
-- app, backed by an actual Team ID instead of a null identifier.
CREATE TABLE app_inventory (
    bundle_id TEXT PRIMARY KEY, -- CFBundleIdentifier, from the app's own
                                 -- Info.plist - the natural stable key,
                                 -- same identity SimpleMDM's own
                                 -- software_packages/installed-apps rows
                                 -- already key display on.
    name TEXT,                  -- CFBundleName, display-only, same
                                 -- "never used for matching" reasoning as
                                 -- safe_app_bundle_ids.name.
    team_id TEXT,                -- The actual Team ID this table exists
                                 -- for - NULL for an app that's unsigned,
                                 -- ad-hoc signed, or (like Apple's own
                                 -- platform binaries) signed with no Team
                                 -- ID at all. A NULL here means this app
                                 -- has no usable identifier for a Team-ID
                                 -- ALLOWLIST rule, same "no action
                                 -- offered" treatment as
                                 -- handleListInstalledSoftware's own
                                 -- null-identifier rows.
    path TEXT,                  -- Where the daemon found it (normally
                                 -- under /Applications) - display-only.
    first_seen_at INTEGER NOT NULL, -- Set once, at INSERT, never touched
                                     -- again - lets the dashboard show
                                     -- "just appeared" for a genuinely
                                     -- new app.
    last_seen_at INTEGER NOT NULL   -- Bumped on every sync that still
                                     -- reports this bundle_id - see
                                     -- db.ts's upsertAppInventoryEntry.
                                     -- Rows this project's own pruning
                                     -- (same function) removes once a
                                     -- sync no longer reports them at
                                     -- all (the app was uninstalled),
                                     -- rather than leaving a permanently
                                     -- stale row.
);
