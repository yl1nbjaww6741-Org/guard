import type { ClientMode, Env, EventEntry, Rule, RuleType, Policy } from "./types";

const RULE_PAGE_SIZE = 100; // Santa's own default batch_size for events is
// 50 (sync/v1.proto's PreflightResponse.batch_size comment) - rules aren't
// documented with a specific default, 100 is a deliberate, reasonable
// choice for this project's tiny hand-maintained rule set, not a value
// copied from anywhere.

export async function upsertDevice(
  db: D1Database,
  machineId: string,
  fields: {
    hostname?: string;
    osVersion?: string;
    osBuild?: string;
    modelIdentifier?: string;
    santaVersion?: string;
    primaryUser?: string;
  }
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO devices (machine_id, owner, hostname, os_version, os_build, model_identifier, santa_version, client_mode, last_preflight_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'MONITOR', ?8, ?8)
       ON CONFLICT(machine_id) DO UPDATE SET
         owner = excluded.owner,
         hostname = excluded.hostname,
         os_version = excluded.os_version,
         os_build = excluded.os_build,
         model_identifier = excluded.model_identifier,
         santa_version = excluded.santa_version,
         last_preflight_at = excluded.last_preflight_at`
    )
    .bind(
      machineId,
      fields.primaryUser ?? "unknown",
      fields.hostname ?? null,
      fields.osVersion ?? null,
      fields.osBuild ?? null,
      fields.modelIdentifier ?? null,
      fields.santaVersion ?? null,
      now
    )
    .run();
}

export async function getDeviceClientMode(db: D1Database, machineId: string): Promise<ClientMode> {
  const row = await db
    .prepare(`SELECT client_mode FROM devices WHERE machine_id = ?1`)
    .bind(machineId)
    .first<{ client_mode: ClientMode }>();
  // MONITOR is the safe default if a device somehow isn't in the table
  // yet (shouldn't happen - preflight always upserts first) - never
  // default to LOCKDOWN or STANDALONE without an explicit row saying so.
  return row?.client_mode ?? "MONITOR";
}

export async function markPostflight(db: D1Database, machineId: string): Promise<void> {
  await db
    .prepare(`UPDATE devices SET last_postflight_at = ?1 WHERE machine_id = ?2`)
    .bind(Date.now(), machineId)
    .run();
}

export interface DeviceRecord {
  machine_id: string;
  owner: string;
  hostname: string | null;
  os_version: string | null;
  santa_version: string | null;
  client_mode: ClientMode;
  last_preflight_at: number | null;
  last_postflight_at: number | null;
}

// Backs the dashboard's "Sync health" section - this is Santa's own
// sync activity (upsertDevice/markPostflight above), a genuinely
// different signal from Fleet's "online/offline" status
// (fleetClient.ts's getHostStatus): a Mac can be Fleet-online while
// Santa's sync is stalled (wrong/expired SANTA_SYNC_TOKEN, Gateway
// blocking the connection again - both real failure modes already hit
// once in this project's own history) and neither signal substitutes
// for the other. Ordered most-recently-synced first so a stalled device
// among several would still surface near the top.
export async function listDevices(db: D1Database): Promise<DeviceRecord[]> {
  const result = await db
    .prepare(
      `SELECT machine_id, owner, hostname, os_version, santa_version, client_mode, last_preflight_at, last_postflight_at
       FROM devices ORDER BY last_preflight_at DESC`
    )
    .all<DeviceRecord>();
  return result.results ?? [];
}

interface RuleRow {
  id: number;
  identifier: string;
  policy: Policy;
  rule_type: RuleType;
  custom_msg: string | null;
  custom_url: string | null;
  notification_app_name: string | null;
}

// Returns rules that apply to this device (global, device_id IS NULL, or
// scoped to this specific device) that haven't been synced yet - matches
// SyncType.NORMAL semantics from sync/v1.proto: "Santa will apply newly
// received rules on top of any existing rules", so already-synced rules
// don't need to be resent every single sync.
export async function getUnsyncedRulesForDevice(
  db: D1Database,
  machineId: string,
  cursorOffset: number
): Promise<{ rules: Rule[]; ruleIds: number[]; nextCursor: string | null }> {
  const result = await db
    .prepare(
      `SELECT id, identifier, policy, rule_type, custom_msg, custom_url, notification_app_name
       FROM rules
       WHERE (device_id = ?1 OR device_id IS NULL) AND synced_at IS NULL
       ORDER BY id ASC
       LIMIT ?2 OFFSET ?3`
    )
    .bind(machineId, RULE_PAGE_SIZE + 1, cursorOffset)
    .all<RuleRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > RULE_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, RULE_PAGE_SIZE) : rows;

  return {
    rules: page.map((row) => ({
      identifier: row.identifier,
      policy: row.policy,
      rule_type: row.rule_type,
      custom_msg: row.custom_msg ?? undefined,
      custom_url: row.custom_url ?? undefined,
      notification_app_name: row.notification_app_name ?? undefined,
    })),
    ruleIds: page.map((row) => row.id),
    nextCursor: hasMore ? String(cursorOffset + RULE_PAGE_SIZE) : null,
  };
}

export async function markRulesSynced(db: D1Database, ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;
  const now = Date.now();
  // D1 doesn't support binding an array directly into an IN(...) clause -
  // build the placeholder list explicitly rather than string-concatenating
  // the actual IDs into the query (those come from our own DB, not user
  // input, but there's no reason to break the parameterized-query habit).
  const placeholders = ruleIds.map((_, i) => `?${i + 2}`).join(", ");
  await db
    .prepare(`UPDATE rules SET synced_at = ?1 WHERE id IN (${placeholders})`)
    .bind(now, ...ruleIds)
    .run();
}

// --- Rule management (tighten path + ratchet) ---
// See ratchet.ts for the loosen-request queueing/application logic that
// builds on top of these - this file stays limited to raw D1 access,
// same separation as the sync-protocol helpers above.

export interface RuleRecord extends RuleRow {
  device_id: string | null;
}

// Tightening a rule (new BLOCKLIST/ALLOWLIST/etc, or editing an existing
// one to be MORE restrictive) applies immediately - no queue, no delay.
// Only loosening goes through pending_loosen_requests (see ratchet.ts).
// This intentionally does not attempt to distinguish "is this edit
// actually a tightening" - that's the caller's responsibility (the
// dashboard/API route), since a generic upsert has no way to know
// whether e.g. changing a rule's custom_msg counts as tightening.
export async function upsertRule(
  db: D1Database,
  fields: {
    deviceId: string | null;
    identifier: string;
    policy: Policy;
    ruleType: RuleType;
    customMsg?: string;
    customUrl?: string;
    notificationAppName?: string;
  }
): Promise<number> {
  const now = Date.now();
  const result = await db
    .prepare(
      `INSERT INTO rules (device_id, identifier, policy, rule_type, custom_msg, custom_url, notification_app_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       RETURNING id`
    )
    .bind(
      fields.deviceId,
      fields.identifier,
      fields.policy,
      fields.ruleType,
      fields.customMsg ?? null,
      fields.customUrl ?? null,
      fields.notificationAppName ?? null,
      now
    )
    .first<{ id: number }>();
  if (!result) throw new Error("upsertRule: INSERT ... RETURNING id returned no row");
  return result.id;
}

export async function getRuleById(db: D1Database, ruleId: number): Promise<RuleRecord | null> {
  return db
    .prepare(
      `SELECT id, device_id, identifier, policy, rule_type, custom_msg, custom_url, notification_app_name
       FROM rules WHERE id = ?1`
    )
    .bind(ruleId)
    .first<RuleRecord>();
}

export async function listRules(db: D1Database): Promise<RuleRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, device_id, identifier, policy, rule_type, custom_msg, custom_url, notification_app_name
       FROM rules ORDER BY id DESC`
    )
    .all<RuleRecord>();
  return result.results ?? [];
}

// Applies a loosen: sets the rule's policy to REMOVE and marks it
// unsynced so it propagates to Santa on the next sync. Does NOT delete
// the row - keeping loosened rules around (rather than hard-deleting)
// preserves the audit trail of what was ever blocked and later un-blocked,
// which matters more here than in a typical CRUD app given what this
// project is for.
export async function applyLoosen(db: D1Database, ruleId: number): Promise<void> {
  await db
    .prepare(`UPDATE rules SET policy = 'REMOVE', synced_at = NULL, updated_at = ?1 WHERE id = ?2`)
    .bind(Date.now(), ruleId)
    .run();
}

// --- Ratchet: pending loosen requests ---

export interface PendingLoosenRequest {
  id: number;
  rule_id: number;
  requested_at: number;
  applies_at: number;
  applied_at: number | null;
  cancelled_at: number | null;
}

const LOOSEN_DELAY_MS = 24 * 60 * 60 * 1000; // 24h, per mac/README.md's
// Phase 4 row - not configurable per-request, deliberately: a
// dashboard-exposed "how long should this delay be" setting would just
// move the impulse-control problem one level up.

export async function hasActivePendingLoosen(db: D1Database, ruleId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM pending_loosen_requests
       WHERE rule_id = ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(ruleId)
    .first<{ id: number }>();
  return row !== null;
}

export async function queueLoosenRequest(db: D1Database, ruleId: number): Promise<PendingLoosenRequest> {
  const now = Date.now();
  const appliesAt = now + LOOSEN_DELAY_MS;
  const result = await db
    .prepare(
      `INSERT INTO pending_loosen_requests (rule_id, requested_at, applies_at)
       VALUES (?1, ?2, ?3)
       RETURNING id, rule_id, requested_at, applies_at, applied_at, cancelled_at`
    )
    .bind(ruleId, now, appliesAt)
    .first<PendingLoosenRequest>();
  if (!result) throw new Error("queueLoosenRequest: INSERT ... RETURNING returned no row");
  return result;
}

export async function cancelLoosenRequest(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_loosen_requests SET cancelled_at = ?1
       WHERE id = ?2 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now(), requestId)
    .run();
}

// Every request still in flight (not yet applied or cancelled) - for the
// dashboard to show "loosen requested, applies at <time>" and offer a
// cancel action. Distinct from getDueLoosenRequests below: this includes
// ones that aren't due yet, that one is only what's ready to apply now.
export async function listActiveLoosenRequests(db: D1Database): Promise<PendingLoosenRequest[]> {
  const result = await db
    .prepare(
      `SELECT id, rule_id, requested_at, applies_at, applied_at, cancelled_at
       FROM pending_loosen_requests
       WHERE applied_at IS NULL AND cancelled_at IS NULL
       ORDER BY applies_at ASC`
    )
    .all<PendingLoosenRequest>();
  return result.results ?? [];
}

// Returns every request whose 24h delay has elapsed and hasn't already
// been applied or cancelled - called from the scheduled handler, and
// callable directly for tests (see index.ts's scheduled export).
export async function getDueLoosenRequests(db: D1Database): Promise<PendingLoosenRequest[]> {
  const result = await db
    .prepare(
      `SELECT id, rule_id, requested_at, applies_at, applied_at, cancelled_at
       FROM pending_loosen_requests
       WHERE applies_at <= ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now())
    .all<PendingLoosenRequest>();
  return result.results ?? [];
}

export async function markLoosenRequestApplied(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare(`UPDATE pending_loosen_requests SET applied_at = ?1 WHERE id = ?2`)
    .bind(Date.now(), requestId)
    .run();
}

// --- Software packages (Fleet API integration) ---

export interface SoftwarePackageRecord {
  title_id: number;
  name: string;
  version: string | null;
  platform: string | null;
  hash_sha256: string | null;
  uploaded_at: number;
}

export async function recordUploadedPackage(
  db: D1Database,
  pkg: { titleId: number; name: string; version?: string; platform?: string; hashSha256?: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO software_packages (title_id, name, version, platform, hash_sha256, uploaded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(title_id) DO UPDATE SET
         name = excluded.name, version = excluded.version,
         platform = excluded.platform, hash_sha256 = excluded.hash_sha256,
         uploaded_at = excluded.uploaded_at`
    )
    .bind(pkg.titleId, pkg.name, pkg.version ?? null, pkg.platform ?? null, pkg.hashSha256 ?? null, Date.now())
    .run();
}

export async function listSoftwarePackages(db: D1Database): Promise<SoftwarePackageRecord[]> {
  const result = await db
    .prepare(`SELECT title_id, name, version, platform, hash_sha256, uploaded_at FROM software_packages ORDER BY uploaded_at DESC`)
    .all<SoftwarePackageRecord>();
  return result.results ?? [];
}

export async function recordEvents(db: D1Database, machineId: string, events: EventEntry[]): Promise<void> {
  if (events.length === 0) return;
  const now = Date.now();
  const statements = events.map((event) =>
    db
      .prepare(
        `INSERT INTO events (device_id, file_path, file_name, file_sha256, team_id, decision, execution_time, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        machineId,
        event.file_path ?? null,
        event.file_name ?? null,
        event.file_sha256 ?? null,
        event.team_id ?? null,
        event.decision,
        event.execution_time,
        now
      )
  );
  await db.batch(statements);
}

// --- Dashboard password auth (replaces Cloudflare Access - see
// schema.sql's dashboard_auth comment) ---

// Returns null if no password has been bootstrapped yet - see
// mac/docs/PHASE_4_DASHBOARD_SETUP.md's setup steps. Login always fails
// in that state (fail closed), never treated as "anyone can set one."
export async function getDashboardPasswordHash(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT password_hash FROM dashboard_auth WHERE id = 1`).first<{ password_hash: string }>();
  return row?.password_hash ?? null;
}

export async function setDashboardPasswordHash(db: D1Database, passwordHash: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO dashboard_auth (id, password_hash, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`
    )
    .bind(passwordHash, now)
    .run();
}

// login_auth - the separate, non-ratcheted login credential (schema.sql's
// own comment on both tables explains the split). Same shape as
// dashboard_auth's pair of functions above, different table, and
// setLoginPasswordHash is called directly from index.ts's
// handleChangeLoginPassword - no pending/ratchet table involved, unlike
// setDashboardPasswordHash which is only ever called from
// ratchet.ts's applyDuePasswordChanges once a queued change comes due.
export async function getLoginPasswordHash(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT password_hash FROM login_auth WHERE id = 1`).first<{ password_hash: string }>();
  return row?.password_hash ?? null;
}

export async function setLoginPasswordHash(db: D1Database, passwordHash: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO login_auth (id, password_hash, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`
    )
    .bind(passwordHash, now)
    .run();
}

// --- Login lockout (mitigates dropping Cloudflare Access's edge-level
// brute-force protection - see auth.ts's requireSession doc comment) ---

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes - long enough
// to make brute-forcing impractical, short enough that a genuine
// mistyped-password lockout for the real user resolves itself quickly
// without needing any manual unlock mechanism.

export async function recordFailedLoginAttempt(db: D1Database): Promise<void> {
  await db.prepare(`INSERT INTO failed_login_attempts (attempted_at) VALUES (?1)`).bind(Date.now()).run();
}

export async function isLoginLockedOut(db: D1Database): Promise<boolean> {
  const windowStart = Date.now() - LOGIN_LOCKOUT_WINDOW_MS;
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM failed_login_attempts WHERE attempted_at > ?1`)
    .bind(windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 0) >= LOGIN_MAX_FAILURES;
}

export async function clearFailedLoginAttempts(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM failed_login_attempts`).run();
}

// --- Password change ratchet (same shape as pending_loosen_requests -
// see ratchet.ts, which applies both from the same scheduled handler) ---

export interface PendingPasswordChange {
  id: number;
  new_password_hash: string;
  requested_at: number;
  applies_at: number;
  applied_at: number | null;
  cancelled_at: number | null;
}

const PASSWORD_CHANGE_DELAY_MS = 24 * 60 * 60 * 1000; // Same 24h as the
// rule-loosen ratchet - deliberately not configurable, same reasoning
// as ratchet.ts's LOOSEN_DELAY_MS.

export async function hasActivePendingPasswordChange(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM pending_password_changes WHERE applied_at IS NULL AND cancelled_at IS NULL`)
    .first<{ id: number }>();
  return row !== null;
}

export async function queuePasswordChange(db: D1Database, newPasswordHash: string): Promise<PendingPasswordChange> {
  const now = Date.now();
  const appliesAt = now + PASSWORD_CHANGE_DELAY_MS;
  const result = await db
    .prepare(
      `INSERT INTO pending_password_changes (new_password_hash, requested_at, applies_at)
       VALUES (?1, ?2, ?3)
       RETURNING id, new_password_hash, requested_at, applies_at, applied_at, cancelled_at`
    )
    .bind(newPasswordHash, now, appliesAt)
    .first<PendingPasswordChange>();
  if (!result) throw new Error("queuePasswordChange: INSERT ... RETURNING returned no row");
  return result;
}

export async function getActivePendingPasswordChange(db: D1Database): Promise<PendingPasswordChange | null> {
  return db
    .prepare(`SELECT id, new_password_hash, requested_at, applies_at, applied_at, cancelled_at
              FROM pending_password_changes WHERE applied_at IS NULL AND cancelled_at IS NULL`)
    .first<PendingPasswordChange>();
}

export async function cancelPasswordChange(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_password_changes SET cancelled_at = ?1
       WHERE id = ?2 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now(), requestId)
    .run();
}

export async function getDuePasswordChanges(db: D1Database): Promise<PendingPasswordChange[]> {
  const result = await db
    .prepare(
      `SELECT id, new_password_hash, requested_at, applies_at, applied_at, cancelled_at
       FROM pending_password_changes
       WHERE applies_at <= ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now())
    .all<PendingPasswordChange>();
  return result.results ?? [];
}

export async function markPasswordChangeApplied(db: D1Database, requestId: number): Promise<void> {
  await db.prepare(`UPDATE pending_password_changes SET applied_at = ?1 WHERE id = ?2`).bind(Date.now(), requestId).run();
}

// --- MDM config profile change ratchet (same shape/delay as
// pending_loosen_requests and pending_password_changes above - see
// ratchet.ts and schema.sql's own comment on pending_profile_changes for
// the real gap this closes) ---

export type ProfileChangeAction = "create" | "update";

// Public/list shape - deliberately excludes file_content (the raw
// uploaded bytes have no reason to round-trip back to the dashboard,
// and BLOB columns aren't cheap to shuttle through JSON for no reason).
export interface PendingProfileChangeSummary {
  id: number;
  action: ProfileChangeAction;
  profile_uuid: string | null;
  filename: string | null;
  requested_at: number;
  applies_at: number;
  applied_at: number | null;
  cancelled_at: number | null;
  apply_error: string | null;
}

// Only used internally by the scheduled apply step, which is the one
// place that actually needs the real bytes to hand to Fleet.
export interface PendingProfileChangeWithContent extends PendingProfileChangeSummary {
  file_content: ArrayBuffer;
}

const PROFILE_CHANGE_DELAY_MS = 24 * 60 * 60 * 1000; // Same 24h as every
// other ratchet delay in this file - deliberately not configurable, same
// reasoning as LOOSEN_DELAY_MS/PASSWORD_CHANGE_DELAY_MS above.

// Only meaningful for 'update' (a 'create' has no profile_uuid yet to
// collide on) - prevents queuing two competing updates for the same
// profile, same "which one applies?" ambiguity this pattern already
// avoids for rule loosens.
export async function hasActivePendingProfileChange(db: D1Database, profileUuid: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM pending_profile_changes
       WHERE profile_uuid = ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(profileUuid)
    .first<{ id: number }>();
  return row !== null;
}

export async function queueProfileChange(
  db: D1Database,
  fields: { action: ProfileChangeAction; profileUuid: string | null; filename: string | null; fileContent: ArrayBuffer }
): Promise<PendingProfileChangeSummary> {
  const now = Date.now();
  const appliesAt = now + PROFILE_CHANGE_DELAY_MS;
  const result = await db
    .prepare(
      `INSERT INTO pending_profile_changes (action, profile_uuid, filename, file_content, requested_at, applies_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       RETURNING id, action, profile_uuid, filename, requested_at, applies_at, applied_at, cancelled_at, apply_error`
    )
    .bind(fields.action, fields.profileUuid, fields.filename, fields.fileContent, now, appliesAt)
    .first<PendingProfileChangeSummary>();
  if (!result) throw new Error("queueProfileChange: INSERT ... RETURNING returned no row");
  return result;
}

export async function cancelProfileChange(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_profile_changes SET cancelled_at = ?1
       WHERE id = ?2 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now(), requestId)
    .run();
}

// Every request still in flight - for the dashboard to show "queued,
// applies at <time>" and offer a cancel action, same as
// listActiveLoosenRequests above.
export async function listActiveProfileChanges(db: D1Database): Promise<PendingProfileChangeSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, action, profile_uuid, filename, requested_at, applies_at, applied_at, cancelled_at, apply_error
       FROM pending_profile_changes
       WHERE applied_at IS NULL AND cancelled_at IS NULL
       ORDER BY applies_at ASC`
    )
    .all<PendingProfileChangeSummary>();
  return result.results ?? [];
}

// Includes file_content - only the scheduled apply step calls this.
export async function getDueProfileChanges(db: D1Database): Promise<PendingProfileChangeWithContent[]> {
  const result = await db
    .prepare(
      `SELECT id, action, profile_uuid, filename, file_content, requested_at, applies_at, applied_at, cancelled_at, apply_error
       FROM pending_profile_changes
       WHERE applies_at <= ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now())
    .all<PendingProfileChangeWithContent>();
  return result.results ?? [];
}

export async function markProfileChangeApplied(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare(`UPDATE pending_profile_changes SET applied_at = ?1, apply_error = NULL WHERE id = ?2`)
    .bind(Date.now(), requestId)
    .run();
}

// Left un-applied (applied_at stays NULL) so the next scheduled tick
// retries automatically - a transient Fleet outage shouldn't mean a
// queued change silently never happens. apply_error is surfaced on the
// dashboard so a persistent failure (e.g. a genuine Fleet rejection,
// not a blip) doesn't go unnoticed indefinitely either.
export async function markProfileChangeFailed(db: D1Database, requestId: number, errorMessage: string): Promise<void> {
  await db
    .prepare(`UPDATE pending_profile_changes SET apply_error = ?1 WHERE id = ?2`)
    .bind(errorMessage.slice(0, 500), requestId)
    .run();
}

// --- Safe app bundle IDs (ContentGuardDaemon's own capture-scope
// whitelist, synced from here - see schema.sql's safe_app_bundle_ids
// comment and daemonSync.ts for the read side). Adding is a loosening,
// ratchet-gated below; removing is a tightening, immediate, same
// asymmetry as upsertRule/applyLoosen above. ---

export interface SafeAppBundleIdRecord {
  bundle_id: string;
  added_at: number;
  name: string | null;
}

export async function listSafeAppBundleIds(db: D1Database): Promise<SafeAppBundleIdRecord[]> {
  const result = await db
    .prepare(`SELECT bundle_id, added_at, name FROM safe_app_bundle_ids ORDER BY added_at DESC`)
    .all<SafeAppBundleIdRecord>();
  return result.results ?? [];
}

export async function isSafeAppBundleIdApproved(db: D1Database, bundleId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT bundle_id FROM safe_app_bundle_ids WHERE bundle_id = ?1`).bind(bundleId).first();
  return row !== null;
}

// Called only from applyDueSafeAppAdditions once a request's 24h delay
// has elapsed - INSERT OR IGNORE since re-applying an already-approved
// ID (shouldn't happen, but not worth a hard failure over) is a no-op,
// not an error.
export async function addSafeAppBundleId(db: D1Database, bundleId: string, name: string | null): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO safe_app_bundle_ids (bundle_id, added_at, name) VALUES (?1, ?2, ?3)`)
    .bind(bundleId, Date.now(), name)
    .run();
}

// Tightening - applies immediately, no queue, no password re-check, same
// as cancelling a loosen request: staying (or returning to) monitored
// needs no extra friction, only reducing monitoring does. Removing a
// bundle ID that was never approved is a harmless no-op.
export async function removeSafeAppBundleId(db: D1Database, bundleId: string): Promise<void> {
  await db.prepare(`DELETE FROM safe_app_bundle_ids WHERE bundle_id = ?1`).bind(bundleId).run();
}

// --- Ratchet: pending safe-app additions (same shape as
// pending_loosen_requests - see ratchet.ts) ---

export interface PendingSafeAppAddition {
  id: number;
  bundle_id: string;
  requested_at: number;
  applies_at: number;
  applied_at: number | null;
  cancelled_at: number | null;
  name: string | null;
}

const SAFE_APP_ADDITION_DELAY_MS = 24 * 60 * 60 * 1000; // Same 24h as
// every other ratchet delay in this file - deliberately not configurable,
// same reasoning as LOOSEN_DELAY_MS.

export async function hasActivePendingSafeAppAddition(db: D1Database, bundleId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM pending_safe_app_additions
       WHERE bundle_id = ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(bundleId)
    .first<{ id: number }>();
  return row !== null;
}

export async function queueSafeAppAddition(db: D1Database, bundleId: string, name: string | null): Promise<PendingSafeAppAddition> {
  const now = Date.now();
  const appliesAt = now + SAFE_APP_ADDITION_DELAY_MS;
  const result = await db
    .prepare(
      `INSERT INTO pending_safe_app_additions (bundle_id, requested_at, applies_at, name)
       VALUES (?1, ?2, ?3, ?4)
       RETURNING id, bundle_id, requested_at, applies_at, applied_at, cancelled_at, name`
    )
    .bind(bundleId, now, appliesAt, name)
    .first<PendingSafeAppAddition>();
  if (!result) throw new Error("queueSafeAppAddition: INSERT ... RETURNING returned no row");
  return result;
}

export async function cancelSafeAppAddition(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_safe_app_additions SET cancelled_at = ?1
       WHERE id = ?2 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now(), requestId)
    .run();
}

export async function listActiveSafeAppAdditions(db: D1Database): Promise<PendingSafeAppAddition[]> {
  const result = await db
    .prepare(
      `SELECT id, bundle_id, requested_at, applies_at, applied_at, cancelled_at, name
       FROM pending_safe_app_additions
       WHERE applied_at IS NULL AND cancelled_at IS NULL
       ORDER BY applies_at ASC`
    )
    .all<PendingSafeAppAddition>();
  return result.results ?? [];
}

export async function getDueSafeAppAdditions(db: D1Database): Promise<PendingSafeAppAddition[]> {
  const result = await db
    .prepare(
      `SELECT id, bundle_id, requested_at, applies_at, applied_at, cancelled_at, name
       FROM pending_safe_app_additions
       WHERE applies_at <= ?1 AND applied_at IS NULL AND cancelled_at IS NULL`
    )
    .bind(Date.now())
    .all<PendingSafeAppAddition>();
  return result.results ?? [];
}

export async function markSafeAppAdditionApplied(db: D1Database, requestId: number): Promise<void> {
  await db.prepare(`UPDATE pending_safe_app_additions SET applied_at = ?1 WHERE id = ?2`).bind(Date.now(), requestId).run();
}

// --- App inventory (real Team-ID data, daemon-reported - see
// migrations/0008_app_inventory.sql's own comment for why this table
// exists at all and why it can't be fed from SimpleMDM's own API) ---

export interface AppInventoryRecord {
  bundle_id: string;
  name: string | null;
  team_id: string | null;
  path: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

/// Wholesale replace, from a full fresh report - daemonSync.ts's
/// handleAppInventorySync always sends every app AppInventoryScanner
/// currently finds under /Applications, never an incremental diff (same
/// "minimal moving parts" reasoning as this project's other sync
/// clients), so this function's job is reconciling that full report
/// against whatever's already stored, not applying a delta.
export async function replaceAppInventory(
  db: D1Database,
  apps: { bundleId: string; name?: string; teamId?: string; path?: string }[]
): Promise<void> {
  const now = Date.now();
  const statements = apps.map((app) =>
    db
      .prepare(
        `INSERT INTO app_inventory (bundle_id, name, team_id, path, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(bundle_id) DO UPDATE SET
           name = excluded.name, team_id = excluded.team_id, path = excluded.path,
           last_seen_at = excluded.last_seen_at`
      )
      .bind(app.bundleId, app.name ?? null, app.teamId ?? null, app.path ?? null, now)
  );
  if (statements.length > 0) {
    await db.batch(statements);
  }

  // Prune rows this sync no longer reports at all - the app was
  // uninstalled since the last sync. Deliberately NOT "delete everything
  // then reinsert" (which would also work, but would destroy
  // first_seen_at for every still-installed app on every single sync,
  // undermining the whole point of that column - see the migration's own
  // comment). D1 prepared statements don't take a dynamic-length array
  // bind directly, so this builds one ?N placeholder per reported
  // bundle_id instead - fine at this project's real scale (a few dozen
  // installed apps, not thousands).
  const reportedIds = apps.map((app) => app.bundleId);
  if (reportedIds.length === 0) {
    // An empty report is treated as "nothing to prune" rather than
    // "delete everything" - a genuinely empty /Applications scan is far
    // more likely to be a daemon-side bug or a transient failure than a
    // real state, and wiping every row over that would be a real, silent
    // loosening of LOCKDOWN readiness for no good reason. Same "fail
    // toward keeping what's already there" reasoning as
    // SafeAppsSyncClient's own fetch-failure handling.
    return;
  }
  const placeholders = reportedIds.map((_, i) => `?${i + 1}`).join(",");
  await db
    .prepare(`DELETE FROM app_inventory WHERE bundle_id NOT IN (${placeholders})`)
    .bind(...reportedIds)
    .run();
}

export async function listAppInventory(db: D1Database): Promise<AppInventoryRecord[]> {
  const result = await db
    .prepare(`SELECT bundle_id, name, team_id, path, first_seen_at, last_seen_at FROM app_inventory ORDER BY name ASC`)
    .all<AppInventoryRecord>();
  return result.results ?? [];
}
