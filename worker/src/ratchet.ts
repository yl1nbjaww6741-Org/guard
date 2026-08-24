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
  getDueLoosenRequests,
  getDuePasswordChanges,
  getDueProfileChanges,
  getDueSafeAppAdditions,
  hasActivePendingLoosen,
  hasActivePendingPasswordChange,
  hasActivePendingProfileChange,
  hasActivePendingSafeAppAddition,
  isSafeAppBundleIdApproved,
  markLoosenRequestApplied,
  markPasswordChangeApplied,
  markProfileChangeApplied,
  markProfileChangeFailed,
  markSafeAppAdditionApplied,
  queueLoosenRequest,
  queuePasswordChange,
  queueProfileChange,
  queueSafeAppAddition,
  setDashboardPasswordHash,
} from "./db";
import type {
  PendingLoosenRequest,
  PendingPasswordChange,
  PendingProfileChangeSummary,
  PendingSafeAppAddition,
  ProfileChangeAction,
} from "./db";
import { createConfigurationProfile, updateConfigurationProfile } from "./fleetClient";
import type { Env } from "./types";

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
// two ratchets above, this one has to actually reach out to Fleet's real
// API (fleetClient.ts), which can genuinely fail (Fleet unreachable, a
// real rejection like a PayloadIdentifier mismatch on an update). A
// failure here does NOT mark the change applied - it's left in the
// queue with `apply_error` recorded, so the next scheduled tick retries
// automatically rather than the change silently vanishing. Needs `env`
// (not just `db`, unlike the other two apply* functions above) since
// fleetClient.ts's functions need Fleet's own base URL/token.
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
export async function requestAddSafeApp(db: D1Database, bundleId: string): Promise<PendingSafeAppAddition> {
  if (await isSafeAppBundleIdApproved(db, bundleId)) {
    throw new SafeAppAlreadyApprovedError(bundleId);
  }
  if (await hasActivePendingSafeAppAddition(db, bundleId)) {
    throw new SafeAppAdditionAlreadyPendingError(bundleId);
  }
  return queueSafeAppAddition(db, bundleId);
}

export async function applyDueSafeAppAdditions(db: D1Database): Promise<number> {
  const due = await getDueSafeAppAdditions(db);
  for (const request of due) {
    await addSafeAppBundleId(db, request.bundle_id);
    await markSafeAppAdditionApplied(db, request.id);
  }
  return due.length;
}
