-- Incremental migration for the already-deployed remote D1 database - see
-- schema.sql's safe_app_bundle_ids/pending_safe_app_additions comments for
-- what these are and why. Same shape as those two tables there.

CREATE TABLE safe_app_bundle_ids (
    bundle_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
);

CREATE TABLE pending_safe_app_additions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);
