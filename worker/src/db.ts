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
