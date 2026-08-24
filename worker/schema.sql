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
