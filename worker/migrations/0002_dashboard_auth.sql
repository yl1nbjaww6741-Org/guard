-- Incremental migration for the remote D1 database, which already has
-- schema.sql's earlier tables applied (devices, rules,
-- pending_loosen_requests, events, software_packages) - re-running the
-- whole schema.sql again would fail on those already existing. This
-- file contains only the new tables added for password auth (replacing
-- Cloudflare Access - see schema.sql's own comment on dashboard_auth for
-- why), copied verbatim from schema.sql so both stay in sync.
--
-- Apply with: npx wrangler d1 execute contentguard --remote --file=./migrations/0002_dashboard_auth.sql

CREATE TABLE dashboard_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE pending_password_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    new_password_hash TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);

CREATE TABLE failed_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempted_at INTEGER NOT NULL
);
