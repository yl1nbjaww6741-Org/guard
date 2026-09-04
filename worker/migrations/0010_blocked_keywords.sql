-- Re-adds the keyword-blocking subsystem's storage, dropped by
-- 0009_drop_keyword_blocking.sql. Explicit user request, 2026-09-04,
-- re-adding it now that the real bug that got it removed (the
-- dashboard's own Keyword blocker page rendered every blocked keyword
-- as plain text, so the extension's filter started blocking the
-- dashboard itself) has a real fix baked into this reintroduction from
-- the start - see schema.sql's own comment on these two tables, and
-- chrome-extension/content-scripts/keyword-blocker.js /
-- background/service-worker.js for where the panel-origin exemption and
-- the full-phrase-only matching guarantee actually live.
--
-- Same shape as before removal (see git history for
-- 0009_drop_keyword_blocking.sql and the original 0006_blocked_keywords.sql) -
-- nothing about the storage schema itself needed to change, only the
-- matching logic that reads from it.
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
