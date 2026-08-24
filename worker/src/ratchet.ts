// The ratchet mechanism: tightening (add/edit a rule to be more
// restrictive) is immediate, loosening (BLOCKLIST -> REMOVE) is queued
// and only takes effect after both a re-checked password AND a 24-hour
// delay - see mac/README.md's Phase 4 row for why, and auth.ts's
// `verifyLoosenPassword` for the password check itself.

import { applyLoosen, getDueLoosenRequests, hasActivePendingLoosen, markLoosenRequestApplied, queueLoosenRequest } from "./db";
import type { PendingLoosenRequest } from "./db";

export class LoosenAlreadyPendingError extends Error {
  constructor(ruleId: number) {
    super(`rule ${ruleId} already has an active pending loosen request`);
  }
}

// Called by the (not-yet-built) dashboard API once the password check in
// auth.ts's `verifyLoosenPassword` has already passed - this function
// itself doesn't check the password, it only enforces the "don't double
// -queue the same rule" invariant and starts the 24h clock.
export async function requestLoosen(db: D1Database, ruleId: number): Promise<PendingLoosenRequest> {
  if (await hasActivePendingLoosen(db, ruleId)) {
    throw new LoosenAlreadyPendingError(ruleId);
  }
  return queueLoosenRequest(db, ruleId);
}

// Applies every loosen request whose 24h delay has elapsed. Meant to run
// on a schedule (Cloudflare Cron Trigger, see wrangler.toml's [triggers]
// block and index.ts's `scheduled` export) - also exported directly so
// it can be exercised in tests/local verification without waiting on a
// real cron tick.
export async function applyDueLoosenRequests(db: D1Database): Promise<number> {
  const due = await getDueLoosenRequests(db);
  for (const request of due) {
    await applyLoosen(db, request.rule_id);
    await markLoosenRequestApplied(db, request.id);
  }
  return due.length;
}
