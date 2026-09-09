-- Two real ratchet gaps found live (2026-09-09), both in the Santa area,
-- both from the same root cause: an assumption made back when this
-- project ran Santa in MONITOR mode that silently stopped holding once
-- it switched to LOCKDOWN (d144e99) and was never revisited.

-- Gap 1: Santa's client_mode had no ratchet-aware way to change at all.
-- db.ts's upsertDevice INSERTs a new device row with client_mode
-- hardcoded to 'MONITOR' and deliberately never touches it again on
-- conflict (see that function's own comment) - correct for not letting
-- routine sync telemetry clobber a real mode change, but there was
-- never any code path that actually WROTE a different value either.
-- santa-config.mobileconfig's own ClientMode key was switched to
-- LOCKDOWN (2) back in d144e99, but Santa's sync protocol lets the sync
-- server's reported client_mode override the profile's static default
-- once SyncBaseURL is configured - and this Worker's santaSync.ts
-- (getDeviceClientMode) was reporting whatever's actually in this
-- column, which was permanently stuck at 'MONITOR'. Confirmed live: the
-- dashboard's own Sync health section showed "Santa ... MONITOR" days
-- after the profile was switched to LOCKDOWN.
--
-- db.ts's setDeviceClientMode is the real fix (an UPDATE that finally
-- exists). This table is the ratchet half of it: MONITOR -> LOCKDOWN is
-- a tightening (stricter, default-deny) and applies immediately via
-- setDeviceClientMode directly, no row here at all - same asymmetry as
-- every other ratchet table in this schema. LOCKDOWN -> MONITOR is the
-- loosening this table gates.
CREATE TABLE pending_client_mode_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);

-- Gap 2: index.ts's handleCreateRule (POST /api/rules) is commented
-- "Tightening only" and applies immediately, no password, no delay -
-- correct reasoning under MONITOR (default-allow), where creating a new
-- rule of EITHER policy is at worst a tightening (an ALLOWLIST rule
-- under MONITOR is a redundant no-op, never a loosening, since
-- everything not blocklisted already runs). That stopped being true the
-- moment Santa switched to LOCKDOWN (default-deny): under LOCKDOWN, a
-- brand-new ALLOWLIST rule is exactly a loosening (it lets something
-- run that couldn't before) - but handleCreateRule was never revisited,
-- so both the manual "Add rule" form (policy=Allowlist) and the "Allow
-- all" bulk action (dashboard.ts) were applying real loosenings
-- immediately. Confirmed live: the user hit this directly using "Allow
-- all" and it applied with no password prompt at all.
--
-- Fixed by rejecting ALLOWLIST/ALLOWLIST_COMPILER from handleCreateRule
-- entirely (same shape as its existing REMOVE rejection) and routing
-- both the single-row and bulk "Allow" actions through this table
-- instead. Deliberately unconditional - NOT gated on reading the
-- device's current client_mode to decide "is this actually a
-- loosening right now" - trusting a live-read mode value for that is
-- exactly the kind of assumption that already broke once (see Gap 1
-- above); every new ALLOWLIST rule goes through the ratchet regardless
-- of mode, full stop.
--
-- No FK to a rules.id - unlike pending_keyword_removals (which loosens
-- an EXISTING row), this creates a brand-new rule that doesn't exist
-- yet, so the rule's own fields are captured here instead, same shape
-- as rules itself.
CREATE TABLE pending_allowlist_rule_additions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    custom_msg TEXT,
    custom_url TEXT,
    notification_app_name TEXT,
    requested_at INTEGER NOT NULL,
    applies_at INTEGER NOT NULL,
    applied_at INTEGER,
    cancelled_at INTEGER
);
