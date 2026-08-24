-- Incremental migration for the already-deployed remote D1 database - see
-- schema.sql's safe_app_bundle_ids/pending_safe_app_additions comments.
-- Adds an optional display name, now that additions come from the
-- Installed Apps picker (which knows the app's real name at request
-- time) rather than a hand-typed bundle ID with no name attached.

ALTER TABLE safe_app_bundle_ids ADD COLUMN name TEXT;
ALTER TABLE pending_safe_app_additions ADD COLUMN name TEXT;
