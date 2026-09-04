-- ContentGuard control-panel Worker - D1 schema.
--
-- Two things drove the shape of this schema, both from mac/README.md's
-- Phase 4 scope decisions (not guessed - see that phase's row):
--
-- 1. Forward-compat, not current scope: `devices` is a real table with an
--    `owner` column, not a single hardcoded "the Mac" - so a hypothetical
--    future second device/owner (see mac/README.md's Phase 4 row) can be
--    added later without a schema rewrite. No Android work happens here;
--    this is purely about not painting the data model into a corner.
-- 2. `rules.device_id` is nullable so a rule can apply globally (NULL) or
--    be scoped to one specific device - today there's exactly one device,
--    so every real rule will have device_id set, but the column exists
--    now rather than being bolted on later.

CREATE TABLE devices (
    machine_id TEXT PRIMARY KEY, -- Santa's machine_id, see santaSync.ts's
                                  -- comment on where this value comes from
    owner TEXT NOT NULL,
    hostname TEXT,
    os_version TEXT,
    os_build TEXT,
    model_identifier TEXT,
    santa_version TEXT,
    -- Mirrors Santa's own ClientMode enum (MONITOR/LOCKDOWN/STANDALONE) as
    -- the string Santa itself sends/expects - see santaSync.ts's type
    -- definitions for why string, not int, despite santa-config.mobileconfig
    -- using an integer for the same concept: that's a different encoding
    -- (Apple's .mobileconfig plist format for Santa's *static*
    -- configuration profile), not the sync protocol's JSON, which follows
    -- standard proto3 JSON mapping (enum name as a string) per
    -- northpolesec/protos' sync/v1.proto - the actual source this file's
    -- field names and enum strings were built against, not guessed.
    client_mode TEXT NOT NULL DEFAULT 'MONITOR',
    last_preflight_at INTEGER,
    last_postflight_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT REFERENCES devices(machine_id), -- NULL = applies to
                                                     -- every device
    identifier TEXT NOT NULL,
    policy TEXT NOT NULL,    -- ALLOWLIST | BLOCKLIST | REMOVE | ... - see
                              -- santaSync.ts's Policy type for the full set
    rule_type TEXT NOT NULL, -- BINARY | CERTIFICATE | TEAMID | SIGNINGID | CDHASH
    custom_msg TEXT,
    custom_url TEXT,
    notification_app_name TEXT,
    -- Set once a RuleDownload response has actually included this rule at
    -- least once - lets ruledownload only send genuinely new/changed rules
    -- on a normal (non-clean) sync, per SyncType's NORMAL semantics in
    -- sync/v1.proto ("Santa will apply newly received rules on top of any
    -- existing rules").
    synced_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX rules_device_id_idx ON rules(device_id);
CREATE INDEX rules_synced_at_idx ON rules(synced_at);

-- Ratchet mechanism (mac/README.md's Phase 4 row: "tightening applies
-- immediately, loosening needs both a re-entered password at the moment
-- of that action AND a 24-hour delay"). A loosen request is: turn an
-- existing BLOCKLIST rule into a REMOVE rule (or otherwise reduce
-- restriction) - never immediate, always queued here first.
CREATE TABLE pending_loosen_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL REFERENCES rules(id),
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL, -- requested_at + 24h, computed at request
                                  -- time so it survives a Worker restart
    applied_at INTEGER,          -- NULL until the delay elapses and a
                                  -- scheduled run actually applies it
    cancelled_at INTEGER         -- set if the user changes their mind
                                  -- before applies_at - see ratchet.ts
);

-- Minimal event log - EventUpload's payload is large (see sync/v1.proto's
-- Event message) and this project doesn't need most of it; just enough to
-- see what got blocked and when, for the dashboard's own history view
-- (scoped to Santa/Fleet management per Phase 4's row - NOT the same
-- thing as Phase 2's separate, still-local-only detection history).
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(machine_id),
    file_path TEXT,
    file_name TEXT,
    file_sha256 TEXT,
    team_id TEXT,
    decision TEXT NOT NULL, -- Santa's Decision enum, as a string - e.g.
                             -- BLOCK_TEAMID, ALLOW_CERTIFICATE
    execution_time REAL NOT NULL,
    received_at INTEGER NOT NULL
);

CREATE INDEX events_device_id_idx ON events(device_id);

-- Dashboard password auth. Cloudflare Access was tried first (see this
-- file's git history and mac/README.md's Phase 4 row) but abandoned in
-- favor of this - the user has an existing, proven pattern from the
-- ContentGuard Android app: a password gate with its own change flow,
-- and changing the password itself goes through the exact same 24h
-- ratchet as everything else, rather than being a special case.
--
-- This is THE OFFICE/LOOSEN PASSWORD - checked at the moment of every
-- loosen-request (a Santa un-block, a safe-app addition, an MDM
-- profile create/update) and to change itself. Changed
-- 2026-08-25 from this table's original design, where the same hash
-- also gated general dashboard login: real problem that surfaced live -
-- the office password is deliberately kept somewhere the day-to-day
-- user can't casually reach (the whole point of the ratchet), which
-- under the old single-password design meant they couldn't even log in
-- to their own dashboard day-to-day. login_auth below is the fix - a
-- separate, low-friction credential for login/viewing/tightening, with
-- this one still reserved for loosening only. See mac/README.md's
-- Phase 4 row for why they were unified in the first place ("avoid the
-- two ever drifting out of sync after a password change") - that
-- reasoning no longer applies once they're deliberately meant to be
-- different values.
--
-- Singleton row (id always 1) - there's exactly one office password for
-- this whole system, not per-user, matching the rest of this project's
-- single-operator design.
CREATE TABLE dashboard_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL, -- SHA-256 hex digest, never the raw password
    updated_at INTEGER NOT NULL
);
-- No seed row - bootstrapping the first password is a deliberate manual
-- step (see mac/docs/PHASE_4_DASHBOARD_SETUP.md), not a code path that
-- treats "no row yet" as "let anyone set one." Consistent with this
-- project's fail-closed default everywhere else.

-- THE LOGIN PASSWORD - separate credential from dashboard_auth above,
-- added 2026-08-25 (see that table's comment for the real gap this
-- closes). Gates handleLogin only: reaching the dashboard at all, and
-- from there every tightening action (session-gated, no password re-
-- check) and every loosen-request's initial view (the loosen-request
-- itself still separately re-checks dashboard_auth). Deliberately NOT
-- ratchet-gated when changed - see pending_password_changes below for
-- the office password's own change flow; changing THIS one doesn't
-- loosen or tighten anything, it only decides who can look at/tighten
-- this dashboard, so index.ts's handleChangeLoginPassword applies it
-- immediately once the current login password re-checks, same
-- "no delay for something that isn't a restriction change" reasoning
-- as every other purely-administrative action in this project.
CREATE TABLE login_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
-- No seed row, but UNLIKE dashboard_auth above: self-bootstraps on
-- first use rather than requiring a manual D1 write. index.ts's
-- handleLogin treats "no row yet" as "whatever password just got
-- submitted becomes the login password" - added 2026-08-25 to cover
-- "the Codespace with real Cloudflare credentials isn't working," which
-- left no way to run the manual-insert bootstrap dashboard_auth still
-- requires. Real, deliberately-accepted tradeoff, not unnoticed: this
-- Worker is fully public, so this is a genuine claim-it-first race
-- between deploy and whoever logs in first, not just a bootstrap step -
-- accepted here specifically because it's self-closing (one successful
-- request ends the exposure) and this password's worst case is view/
-- tighten access, never a loosening action. dashboard_auth deliberately
-- does NOT get this same treatment - see that table's comment for why
-- the same tradeoff isn't worth it for the password that gates every
-- loosening action.

-- Password changes follow the identical shape as pending_loosen_requests
-- (queued, 24h delay, cancellable) - see ratchet.ts, which now applies
-- both kinds of pending change from the same scheduled handler. Applies
-- to the OFFICE password (dashboard_auth) only - the login password
-- (login_auth) changes immediately, see that table's own comment.
CREATE TABLE pending_password_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    new_password_hash TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);

-- Login lockout - the one real cost of dropping Cloudflare Access
-- (mac/README.md's Phase 4 row): this Worker is now fully public, so
-- login attempts need their own brute-force protection instead of
-- getting it for free at the edge. Global, not per-IP - there's exactly
-- one legitimate user of this whole system, so any burst of failures
-- from anywhere is worth locking out regardless of source.
CREATE TABLE failed_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempted_at INTEGER NOT NULL
);

-- Software packages uploaded to Fleet through this Worker (fleetClient.ts,
-- Fleet's own POST /api/v1/fleet/software/package - see that file's doc
-- comment for the real API reference this was built against). Keyed by
-- Fleet's own title_id, not an autoincrement of our own, since that's
-- the identifier every later action (install, re-install) needs and
-- there's no reason to invent a second one.
CREATE TABLE software_packages (
    title_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT,
    platform TEXT,
    hash_sha256 TEXT,
    uploaded_at INTEGER NOT NULL
);

-- Ratchet for MDM configuration profile changes - same shape as
-- pending_loosen_requests/pending_password_changes (24h delay, applied
-- from the same scheduled handler, see ratchet.ts), added after a real
-- gap: uploading/replacing a .mobileconfig through the dashboard
-- previously applied instantly, no delay of any kind, completely
-- bypassing the ratchet's whole purpose - found live when the user
-- uploaded a real profile change and noticed there was no cooldown.
-- This Worker has no way to tell whether an uploaded profile is a
-- tightening or a loosening (no plist-parsing dependency, same
-- "minimal moving parts" reasoning as everywhere else in this project -
-- see configProfiles.ts), so every profile create/update is treated as
-- a loosening for ratchet purposes, unconditionally - the safe,
-- fail-closed default, not an attempt to guess.
--
-- The uploaded file's bytes have to be held here for the full 24h delay
-- (there's nowhere else to keep them - Fleet doesn't receive anything
-- until the change actually applies), hence file_content as a BLOB;
-- these are small XML plists (a few KB), nowhere near D1's row-size
-- limits.
CREATE TABLE pending_profile_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('create', 'update')),
    profile_uuid TEXT,   -- NULL for 'create' - Fleet assigns one once applied
    filename TEXT,       -- original uploaded filename, for dashboard display only
    file_content BLOB NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER,
    apply_error TEXT     -- last error if a scheduled apply attempt failed
                          -- (e.g. Fleet unreachable, a real API rejection) -
                          -- left un-applied in that case so the next
                          -- scheduled tick retries automatically, not
                          -- silently dropped
);

-- The Mac-side counterpart to ContentGuardConfig.safeAppBundleIDs
-- (mac/Shared/Config.swift) - moved here so it's dashboard-adjustable
-- instead of requiring a source edit + recompile + codesign + `sudo make
-- install` every time. This is the first table ContentGuardDaemon itself
-- reads (via GET /sync/safe-apps, daemonSync.ts) - previously the daemon
-- made no network calls at all, by deliberate design (Shared/Config.swift's
-- own header: "no dylib to tamper with"). That tradeoff is accepted
-- explicitly here, not by accident: every bundle ID in this table is a
-- screen-capture blind spot (mirrors safeAppBundleIDs's own "every bundle
-- ID here is a blind spot" comment), so adding one is a loosening and goes
-- through the exact same ratchet as everything else on this dashboard
-- (pending_safe_app_additions below) - removing one is a tightening and
-- applies immediately, same asymmetry as rules/upsertRule.
--
-- The compiled ContentGuardConfig.safeAppBundleIDs list is NOT replaced by
-- this table, it's the fallback: the daemon ships with that baseline
-- built in and only ever ADDS to it from what this table (once
-- successfully, authentically fetched) contains - never a source of
-- truth the daemon trusts blindly, and never able to shrink protection
-- below the compiled baseline just because a fetch returned something
-- unexpected or empty.
CREATE TABLE safe_app_bundle_ids (
    bundle_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL,
    -- Human-readable name, from whatever the Installed Apps picker knew
    -- at request time (see dashboard.ts) - display-only, never used for
    -- matching (that's always bundle_id). Nullable: an app whose Fleet
    -- inventory entry has no name at request time, or a row from before
    -- this column existed (migrations/0005_safe_app_names.sql), still
    -- works, just falls back to showing the bundle_id alone.
    name TEXT
);

-- Ratchet for ADDING a bundle ID to safe_app_bundle_ids - same shape as
-- pending_loosen_requests/pending_password_changes/pending_profile_changes
-- (24h delay, applied from the same scheduled handler, see ratchet.ts).
-- No table for removals - those are tightenings and apply immediately
-- via db.ts's removeSafeAppBundleId, same as every other tightening
-- action in this project.
CREATE TABLE pending_safe_app_additions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER,
    name TEXT -- see safe_app_bundle_ids.name's own comment; carried
              -- through to that column once this request is applied
              -- (ratchet.ts's applyDueSafeAppAdditions)
);

-- Keyword blocklist for the Chrome extension (extensionSync.ts's GET
-- /sync/keywords, gated by CONTENTGUARD_EXTENSION_SYNC_TOKEN - see
-- types.ts's Env comment). Opposite ratchet polarity from
-- safe_app_bundle_ids above: ADDING a keyword makes the extension block
-- MORE, so it's a tightening and applies immediately (keywordsApi.ts's
-- handleAddKeyword, no password, same as Santa's handleCreateRule for a
-- new BLOCKLIST rule). REMOVING a keyword makes it block LESS, so it's a
-- loosening and goes through the same 24h-delay-plus-re-entered-password
-- ratchet as everything else (pending_keyword_removals below) - the
-- inverse of safe_app_bundle_ids's own asymmetry, not a copy-paste of it.
--
-- Re-added by migrations/0010_blocked_keywords.sql, 2026-09-04 - briefly
-- removed by 0009_drop_keyword_blocking.sql after a real, self-inflicted
-- bug (the dashboard's own Keyword blocker page necessarily rendered
-- every blocked keyword as plain page text, so the extension's own
-- filter started blocking the dashboard itself the moment a real
-- keyword went on the list). Storage schema is unchanged from before
-- that removal - the fix lives entirely in the matching logic that
-- reads this table (chrome-extension/content-scripts/keyword-blocker.js's
-- panel-origin exemption, chrome-extension/background/service-worker.js's
-- matching declarativeNetRequest exemption), not in what gets stored
-- here. Also explicitly guaranteed from this reintroduction onward:
-- a keyword is only ever matched as its FULL contiguous phrase (plain
-- string .includes()/urlFilter substring matching on the exact stored
-- string, never split into individual words) - see keyword-blocker.js's
-- own comment for why that matters (a multi-word keyword like "reddit
-- media downloader" must never trigger on "reddit" alone appearing on
-- some unrelated page).
CREATE TABLE blocked_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    added_at INTEGER NOT NULL
);

-- Ratchet for REMOVING a blocked_keywords row - same shape as
-- pending_safe_app_additions above, just gating the opposite direction
-- of change (see blocked_keywords's own comment for why). keyword is
-- captured at request time (not just keyword_id) purely for dashboard
-- display of a pending removal without a join, same reasoning as
-- pending_safe_app_additions.name.
CREATE TABLE pending_keyword_removals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword_id INTEGER NOT NULL REFERENCES blocked_keywords(id),
    keyword TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);

-- Real per-app code-signing inventory, daemon-reported (AppInventoryScanner.swift
-- + POST /sync/app-inventory) - see migrations/0008_app_inventory.sql's own
-- comment for the full "why" (SimpleMDM has no code-signing data; this is
-- what makes a real Santa LOCKDOWN allowlist practical). No ratchet table
-- of its own - this whole table is replaced wholesale on every daemon
-- sync (db.ts's replaceAppInventory), not edited from the dashboard.
CREATE TABLE app_inventory (
    bundle_id TEXT PRIMARY KEY,
    name TEXT,
    team_id TEXT,
    path TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
