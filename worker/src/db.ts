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
