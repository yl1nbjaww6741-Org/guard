// Route handlers for config-profile management (/api/config-profiles/...
// and /api/pending-profile-changes/...) - lets the dashboard upload a
// brand-new .mobileconfig to Fleet, or replace an existing one's content
// in place, without needing Fleet's own UI. Thin wrappers, same
// separation as softwareApi.ts.
//
// Every create/update goes through the same 24h-delay-plus-re-entered-
// password ratchet as Santa rule loosening and the dashboard password
// itself (ratchet.ts's requestProfileChange/applyDueProfileChanges) -
// this file only queues the change and re-checks the password; it never
// calls Fleet directly. See schema.sql's pending_profile_changes comment
// for the real gap that made this necessary: uploading/replacing a
// profile here previously applied instantly, with no delay at all,
// completely bypassing the ratchet's whole purpose.

import { cancelProfileChange, getDashboardPasswordHash, listActiveProfileChanges } from "./db";
import { verifyPasswordHash } from "./auth";
import { ProfileChangeAlreadyPendingError, requestProfileChange } from "./ratchet";
import { CONFIG_PROFILES } from "./configProfiles";
import type { Env } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Purely static, hand-kept data (configProfiles.ts) - no Fleet call, no
// D1 read. The dashboard merges this with the live per-profile status
// already fetched via /api/host-status to show what each profile's
// verified/pending/failed row actually restricts.
export function handleListConfigProfileDetails(): Response {
  return jsonResponse(CONFIG_PROFILES);
}

// Re-checks the dashboard password (same contract as
// handleLoosenRequest/handlePasswordChangeRequest in index.ts - being
// logged in already isn't enough) and reads the uploaded file's real
// bytes into memory so they can be held in D1 until the 24h delay
// elapses (ratchet.ts's applyDueProfileChanges is what actually reaches
// Fleet, later). Returns 202 (queued), never 201 - nothing has been
// created in Fleet yet.
async function parseAndAuthorize(
  request: Request,
  env: Env
): Promise<{ file: File; password: string } | Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "expected multipart/form-data body" }, 400);
  }

  const file = formData.get("profile");
  if (!(file instanceof File)) {
    return jsonResponse({ error: "missing required 'profile' file field" }, 400);
  }

  const password = formData.get("password");
  const storedHash = await getDashboardPasswordHash(env.DB);
  if (typeof password !== "string" || !password || !storedHash || !(await verifyPasswordHash(password, storedHash))) {
    return jsonResponse({ error: "incorrect or missing password" }, 403);
  }

  return { file, password };
}

export async function handleUploadConfigProfile(request: Request, env: Env): Promise<Response> {
  const parsed = await parseAndAuthorize(request, env);
  if (parsed instanceof Response) return parsed;

  const fileContent = await parsed.file.arrayBuffer();
  const pending = await requestProfileChange(env.DB, {
    action: "create",
    profileUuid: null,
    filename: parsed.file.name || null,
    fileContent,
  });
  return jsonResponse(pending, 202);
}

// profileUuid identifies which existing Fleet-hosted profile to
// eventually replace - comes from the dashboard's own MDM lockdown table
// (each row already carries the real profile_uuid from /api/host-status),
// never typed in by hand. Fleet itself rejects a replacement whose
// PayloadIdentifier doesn't match the existing profile's - see
// fleetClient.ts's updateConfigurationProfile doc comment for why this
// Worker doesn't duplicate that check itself; that validation happens
// only once the change actually applies, not at queue time.
export async function handleUpdateConfigProfile(profileUuid: string, request: Request, env: Env): Promise<Response> {
  const parsed = await parseAndAuthorize(request, env);
  if (parsed instanceof Response) return parsed;

  const fileContent = await parsed.file.arrayBuffer();
  try {
    const pending = await requestProfileChange(env.DB, {
      action: "update",
      profileUuid,
      filename: parsed.file.name || null,
      fileContent,
    });
    return jsonResponse(pending, 202);
  } catch (error) {
    if (error instanceof ProfileChangeAlreadyPendingError) {
      return jsonResponse({ error: error.message }, 409);
    }
    throw error;
  }
}

export async function handleListPendingProfileChanges(env: Env): Promise<Response> {
  return jsonResponse(await listActiveProfileChanges(env.DB));
}

export async function handleCancelProfileChange(id: number, env: Env): Promise<Response> {
  // No password required to cancel - only to start a change in the first
  // place, same reasoning as cancelling a rule loosen or a password
  // change elsewhere in this project: staying restricted needs no extra
  // friction, only reducing a restriction does.
  await cancelProfileChange(env.DB, id);
  return jsonResponse({ cancelled: true });
}
