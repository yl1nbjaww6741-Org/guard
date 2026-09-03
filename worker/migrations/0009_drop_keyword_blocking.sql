-- Drops the entire keyword-blocking subsystem's storage - see
-- schema.sql's own note at this same spot for why. Real bug, not just a
-- cleanup: the dashboard necessarily renders every blocked keyword as
-- plain page text (that's the whole point of the section that used to
-- manage this table), so the Chrome extension's own filter started
-- blocking the dashboard itself the moment a real keyword went on the
-- list. Combined with keyword matching only ever catching what's on a
-- hand-maintained word list (the NSFW image classifier has no such
-- ceiling), the decision was to drop the feature outright rather than
-- patch around the panel-blocking bug.
--
-- pending_keyword_removals first - it FOREIGN KEY REFERENCES
-- blocked_keywords(id), so it has to go first or SQLite's own
-- referential-integrity check on the second DROP would fail.
DROP TABLE IF EXISTS pending_keyword_removals;
DROP TABLE IF EXISTS blocked_keywords;
