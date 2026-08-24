-- Incremental migration for the remote D1 database - see 0002's own
-- comment for why this exists as a separate file instead of re-running
-- schema.sql wholesale. Adds the ratchet table for MDM configuration
-- profile changes (see schema.sql's own comment on pending_profile_changes
-- for the real gap this closes: uploading/replacing a .mobileconfig
-- through the dashboard previously applied instantly, no delay at all).
--
-- Apply with: npx wrangler d1 execute contentguard --remote --file=./migrations/0003_pending_profile_changes.sql

CREATE TABLE pending_profile_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('create', 'update')),
    profile_uuid TEXT,
    filename TEXT,
    file_content BLOB NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER,
    apply_error TEXT
);
