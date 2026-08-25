-- Separate login credential from dashboard_auth (the office/loosen
-- password) - see schema.sql's own comment on both tables for the real
-- gap this closes: under the old single-password design, the office
-- password being deliberately kept somewhere the day-to-day user can't
-- casually reach also meant they couldn't log in to their own dashboard
-- at all. login_auth is a separate, low-friction credential for login/
-- viewing/tightening; dashboard_auth stays reserved for loosening only.
--
-- No seed row - but unlike dashboard_auth's own original migration
-- (0002), this one self-bootstraps: index.ts's handleLogin treats "no
-- row yet" as "whatever password was just submitted becomes the login
-- password." Added 2026-08-25 after this exact migration's manual-
-- insert bootstrap step turned out to have no fallback when the
-- Codespace holding real Cloudflare credentials wasn't working - see
-- schema.sql's own comment on this table for the accepted tradeoff.
CREATE TABLE login_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
