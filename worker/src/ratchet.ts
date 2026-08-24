// The ratchet mechanism: tightening (add/edit a rule to be more
// restrictive) is immediate, loosening (BLOCKLIST -> REMOVE) is queued
// and only takes effect after both a re-checked password AND a 24-hour
// delay - see mac/README.md's Phase 4 row for why. Changing the
// dashboard password itself goes through the identical mechanism (see
// schema.sql's dashboard_auth comment) - both kinds of pending change
// are applied from the same scheduled handler below.

import {
  applyLoosen,
  getDueLoosenRequests,
  getDuePasswordChanges,
  hasActivePendingLoosen,
  hasActivePendingPasswordChange,
  markLoosenRequestApplied,
  markPasswordChangeApplied,
  queueLoosenRequest,
  queuePasswordChange,
  setDashboardPasswordHash,
} from "./db";
import type { PendingLoosenRequest, PendingPasswordChange } from "./db";

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
