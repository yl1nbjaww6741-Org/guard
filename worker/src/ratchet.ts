// The ratchet mechanism: tightening (add/edit a rule to be more
// restrictive) is immediate, loosening (BLOCKLIST -> REMOVE) is queued
// and only takes effect after both a re-checked password AND a 24-hour
// delay - see mac/README.md's Phase 4 row for why. Changing the
// dashboard password itself goes through the identical mechanism (see
// schema.sql's dashboard_auth comment) - both kinds of pending change
// are applied from the same scheduled handler below.

import {
  addSafeAppBundleId,
  applyLoosen,
  deleteBlockedKeywordRow,
  getBlockedKeywordById,
  getDueAllowlistRuleAdditions,
  getDueClientModeChanges,
  getDueKeywordRemovals,
  getDueLoosenRequests,
  getDuePasswordChanges,
  getDueProfileChanges,
  getDueSafeAppAdditions,
  hasActivePendingAllowlistRuleAddition,
  hasActivePendingClientModeChange,
  hasActivePendingKeywordRemoval,
  hasActivePendingLoosen,
  hasActivePendingPasswordChange,
  hasActivePendingProfileChange,
  hasActivePendingSafeAppAddition,
  hasExistingAllowlistRule,
  isSafeAppBundleIdApproved,
  markAllowlistRuleAdditionApplied,
  markClientModeChangeApplied,
  markKeywordRemovalApplied,
  markLoosenRequestApplied,
  markPasswordChangeApplied,
  markProfileChangeApplied,
  markProfileChangeFailed,
  markSafeAppAdditionApplied,
  queueAllowlistRuleAddition,
  queueClientModeChange,
  queueKeywordRemoval,
  queueLoosenRequest,
  queuePasswordChange,
  queueProfileChange,
  queueSafeAppAddition,
  setDashboardPasswordHash,
  setDeviceClientMode,
  upsertRule,
} from "./db";
import type {
  PendingAllowlistRuleAddition,
  PendingClientModeChange,
  PendingKeywordRemoval,
  PendingLoosenRequest,
  PendingPasswordChange,
  PendingProfileChangeSummary,
  PendingSafeAppAddition,
  ProfileChangeAction,
} from "./db";
import { createConfigurationProfile, updateConfigurationProfile } from "./simpleMdmClient";
import type { ClientMode, Env, RuleType } from "./types";

export class LoosenAlreadyPendingError extends Error {
  constructor(ruleId: number) {
    super(`rule ${ruleId} already has an active pending loosen request`);
  }
}

export class PasswordChangeAlreadyPendingError extends Error {
  constructor() {
    super("a password change is already pending");
  }
}

export class ProfileChangeAlreadyPendingError extends Error {
  constructor(profileUuid: string) {
    super(`profile ${profileUuid} already has an active pending change`);
  }
}

export class SafeAppAlreadyApprovedError extends Error {
  constructor(bundleId: string) {
    super(`${bundleId} is already an approved safe app`);
  }
}

export class SafeAppAdditionAlreadyPendingError extends Error {
  constructor(bundleId: string) {
    super(`${bundleId} already has an active pending addition request`);
  }
}

export class KeywordNotFoundError extends Error {
  constructor(id: number) {
    super(`no blocked keyword with id ${id}`);
  }
}

export class KeywordRemovalAlreadyPendingError extends Error {
  constructor(keyword: string) {
    super(`"${keyword}" already has an active pending removal request`);
  }
}

export class ClientModeAlreadyLooseError extends Error {
  constructor(machineId: string) {
    super(`device ${machineId} is not in LOCKDOWN - nothing to loosen`);
  }
}

export class ClientModeChangeAlreadyPendingError extends Error {
  constructor(machineId: string) {
    super(`device ${machineId} already has an active pending client_mode change`);
  }
}

export class AllowlistRuleAlreadyApprovedError extends Error {
  constructor(identifier: string) {
    super(`${identifier} already has an active ALLOWLIST rule`);
  }
}

export class AllowlistAdditionAlreadyPendingError extends Error {
  constructor(identifier: string) {
    super(`${identifier} already has an active pending ALLOWLIST addition request`);
  }
}

// Called by the dashboard API once the current-password re-check has
// already passed - this function itself doesn't verify anything, it
// only enforces the "don't double-queue the same rule" invariant and
// starts the 24h clock.
export async function requestLoosen(db: D1Database, ruleId: number): Promise<PendingLoosenRequest> {
  if (await hasActivePendingLoosen(db, ruleId)) {
    throw new LoosenAlreadyPendingError(ruleId);
  }
  return queueLoosenRequest(db, ruleId);
}

// Same shape as requestLoosen, for the dashboard password itself. Only
// one pending change allowed at a time - queuing a second one before the
// first resolves would just be confusing (which one applies?), not a
// meaningful extra restriction.
export async function requestPasswordChange(db: D1Database, newPasswordHash: string): Promise<PendingPasswordChange> {
  if (await hasActivePendingPasswordChange(db)) {
    throw new PasswordChangeAlreadyPendingError();
  }
  return queuePasswordChange(db, newPasswordHash);
}

// Applies every loosen request AND every password change whose 24h delay
// has elapsed. Meant to run on a schedule (Cloudflare Cron Trigger, see
// wrangler.toml's [triggers] block and index.ts's `scheduled` export) -
// also exported directly so it can be exercised in tests/local
// verification without waiting on a real cron tick.
export async function applyDueLoosenRequests(db: D1Database): Promise<number> {
  const due = await getDueLoosenRequests(db);
  for (const request of due) {
    await applyLoosen(db, request.rule_id);
    await markLoosenRequestApplied(db, request.id);
  }
  return due.length;
}

export async function applyDuePasswordChanges(db: D1Database): Promise<number> {
  const due = await getDuePasswordChanges(db);
  for (const change of due) {
    await setDashboardPasswordHash(db, change.new_password_hash);
    await markPasswordChangeApplied(db, change.id);
  }
  return due.length;
}

// Every MDM configuration profile create/update now goes through this
// same ratchet - see schema.sql's pending_profile_changes comment for
// the real gap this closes: uploading/replacing a .mobileconfig through
// the dashboard previously applied instantly, no delay of any kind.
// Called by the dashboard API once the current-password re-check has
// already passed (same contract as requestLoosen/requestPasswordChange
// above) - this function itself only enforces the "don't double-queue
// the same profile" invariant (update only - a create has no
// profile_uuid yet to collide on) and starts the 24h clock.
export async function requestProfileChange(
  db: D1Database,
  fields: { action: ProfileChangeAction; profileUuid: string | null; filename: string | null; fileContent: ArrayBuffer }
): Promise<PendingProfileChangeSummary> {
  if (fields.action === "update" && fields.profileUuid && (await hasActivePendingProfileChange(db, fields.profileUuid))) {
    throw new ProfileChangeAlreadyPendingError(fields.profileUuid);
  }
  return queueProfileChange(db, fields);
}

// Applies every profile change whose 24h delay has elapsed - unlike the
// two ratchets above, this one has to actually reach out to SimpleMDM's
// real API (simpleMdmClient.ts - migrated off fleetClient.ts, see
// mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md), which can
// genuinely fail (SimpleMDM unreachable, a real rejection). A failure
// here does NOT mark the change applied - it's left in the queue with
// `apply_error` recorded, so the next scheduled tick retries
// automatically rather than the change silently vanishing. Needs `env`
// (not just `db`, unlike the other two apply* functions above) since
// simpleMdmClient.ts's functions need SIMPLEMDM_API_KEY.
export async function applyDueProfileChanges(env: Env): Promise<number> {
  const due = await getDueProfileChanges(env.DB);
  let appliedCount = 0;
  for (const change of due) {
    try {
      const formData = new FormData();
      formData.append("profile", new Blob([change.file_content]), change.filename ?? "profile.mobileconfig");
      if (change.action === "create") {
        await createConfigurationProfile(env, formData);
      } else {
        if (!change.profile_uuid) {
          throw new Error(`pending profile change ${change.id} has action 'update' but no profile_uuid`);
        }
        await updateConfigurationProfile(env, change.profile_uuid, formData);
      }
      await markProfileChangeApplied(env.DB, change.id);
      appliedCount++;
    } catch (error) {
      console.error(`failed to apply pending profile change ${change.id}:`, error);
      await markProfileChangeFailed(env.DB, change.id, error instanceof Error ? error.message : String(error));
    }
  }
  return appliedCount;
}

// A safe-app addition is unambiguously a loosening (mirrors
// safeAppBundleIDs's own "every bundle ID here is a blind spot" comment
// in Config.swift) - queued through the same ratchet as everything else.
// Called by the dashboard API once the current-password re-check has
// already passed (same contract as requestLoosen/requestProfileChange
// above). Rejects both "already approved" and "already queued" up front
// rather than letting a duplicate silently queue a second, redundant
// 24h wait.
export async function requestAddSafeApp(db: D1Database, bundleId: string, name: string | null): Promise<PendingSafeAppAddition> {
  if (await isSafeAppBundleIdApproved(db, bundleId)) {
    throw new SafeAppAlreadyApprovedError(bundleId);
  }
  if (await hasActivePendingSafeAppAddition(db, bundleId)) {
    throw new SafeAppAdditionAlreadyPendingError(bundleId);
  }
  return queueSafeAppAddition(db, bundleId, name);
}

export async function applyDueSafeAppAdditions(db: D1Database): Promise<number> {
  const due = await getDueSafeAppAdditions(db);
  for (const request of due) {
    await addSafeAppBundleId(db, request.bundle_id, request.name);
    await markSafeAppAdditionApplied(db, request.id);
  }
  return due.length;
}

// Removing a blocked keyword is unambiguously a loosening (the extension
// blocks less once it's gone) - queued through the same ratchet as
// everything else. Called by the dashboard API once the current-password
// re-check has already passed (same contract as requestLoosen/
// requestAddSafeApp above). Looks the keyword up by id first so the
// request row can capture its text at request time (same reasoning as
// requestAddSafeApp capturing name) and so a bogus/already-deleted id
// fails clearly rather than queuing a removal for nothing.
export async function requestRemoveKeyword(db: D1Database, keywordId: number): Promise<PendingKeywordRemoval> {
  const existing = await getBlockedKeywordById(db, keywordId);
  if (!existing) {
    throw new KeywordNotFoundError(keywordId);
  }
  if (await hasActivePendingKeywordRemoval(db, keywordId)) {
    throw new KeywordRemovalAlreadyPendingError(existing.keyword);
  }
  return queueKeywordRemoval(db, keywordId, existing.keyword);
}

export async function applyDueKeywordRemovals(db: D1Database): Promise<number> {
  const due = await getDueKeywordRemovals(db);
  for (const request of due) {
    await deleteBlockedKeywordRow(db, request.keyword_id);
    await markKeywordRemovalApplied(db, request.id);
  }
  return due.length;
}

// LOCKDOWN -> MONITOR only - the loosening direction. The reverse
// (MONITOR -> LOCKDOWN) is a tightening and index.ts calls
// db.ts's setDeviceClientMode directly, never through here - see
// pending_client_mode_changes's own schema.sql comment for the real gap
// this closes. Rejects "already MONITOR" up front the same shape as
// requestAddSafeApp's "already approved" check - mode is a two-value
// enum here in practice (STANDALONE isn't used by this project), so
// "not currently LOCKDOWN" and "already loose" are the same condition.
export async function requestSetClientModeToMonitor(db: D1Database, machineId: string, currentMode: ClientMode): Promise<PendingClientModeChange> {
  if (currentMode !== "LOCKDOWN") {
    throw new ClientModeAlreadyLooseError(machineId);
  }
  if (await hasActivePendingClientModeChange(db, machineId)) {
    throw new ClientModeChangeAlreadyPendingError(machineId);
  }
  return queueClientModeChange(db, machineId);
}

export async function applyDueClientModeChanges(db: D1Database): Promise<number> {
  const due = await getDueClientModeChanges(db);
  for (const request of due) {
    await setDeviceClientMode(db, request.machine_id, "MONITOR");
    await markClientModeChangeApplied(db, request.id);
  }
  return due.length;
}

// Creating a brand-new ALLOWLIST rule - see pending_allowlist_rule_additions's
// own schema.sql comment for the real gap this closes (index.ts's
// handleCreateRule now rejects ALLOWLIST/ALLOWLIST_COMPILER outright,
// same shape as its existing REMOVE rejection, and routes here instead).
// Deliberately unconditional on the device's current client_mode - see
// that same comment for why trusting a live-read mode value to decide
// "is this actually a loosening right now" is exactly the assumption
// that broke once already. Rejects both "already has an ALLOWLIST rule"
// and "already queued" up front, same shape as requestAddSafeApp.
export async function requestCreateAllowlistRule(
  db: D1Database,
  fields: { identifier: string; ruleType: RuleType; customMsg: string | null; customUrl: string | null; notificationAppName: string | null }
): Promise<PendingAllowlistRuleAddition> {
  if (await hasExistingAllowlistRule(db, fields.identifier, fields.ruleType)) {
    throw new AllowlistRuleAlreadyApprovedError(fields.identifier);
  }
  if (await hasActivePendingAllowlistRuleAddition(db, fields.identifier, fields.ruleType)) {
    throw new AllowlistAdditionAlreadyPendingError(fields.identifier);
  }
  return queueAllowlistRuleAddition(db, fields);
}

export async function applyDueAllowlistRuleCreations(db: D1Database): Promise<number> {
  const due = await getDueAllowlistRuleAdditions(db);
  for (const request of due) {
    await upsertRule(db, {
      deviceId: null,
      identifier: request.identifier,
      policy: "ALLOWLIST",
      ruleType: request.rule_type,
      customMsg: request.custom_msg ?? undefined,
      customUrl: request.custom_url ?? undefined,
      notificationAppName: request.notification_app_name ?? undefined,
    });
    await markAllowlistRuleAdditionApplied(db, request.id);
  }
  return due.length;
}
