-- Incremental migration for the already-deployed remote D1 database - see
-- schema.sql's blocked_keywords/pending_keyword_removals comments for the
-- full reasoning (Chrome extension keyword blocklist, opposite ratchet
-- polarity from safe_app_bundle_ids).

CREATE TABLE blocked_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    added_at INTEGER NOT NULL
);

CREATE TABLE pending_keyword_removals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword_id INTEGER NOT NULL REFERENCES blocked_keywords(id),
    keyword TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);
