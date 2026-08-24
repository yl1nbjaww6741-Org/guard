// Route handlers for config-profile management (/api/config-profiles/...)
// - lets the dashboard upload a brand-new .mobileconfig to Fleet, or
// replace an existing one's content in place, without needing Fleet's
// own UI. Thin wrappers around fleetClient.ts, same separation as
// softwareApi.ts.

import { createConfigurationProfile, updateConfigurationProfile } from "./fleetClient";
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

// Expects a multipart/form-data body already shaped for Fleet's own
// "Create configuration profile" endpoint (see fleetClient.ts's
// createConfigurationProfile doc comment) - passed straight through,
// same reasoning as handleUploadPackage in softwareApi.ts.
export async function handleUploadConfigProfile(request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "expected multipart/form-data body" }, 400);
  }
  if (!formData.get("profile")) {
    return jsonResponse({ error: "missing required 'profile' file field" }, 400);
  }

  const result = await createConfigurationProfile(env, formData);
  return jsonResponse(result, 201);
}

// profileUuid identifies which existing Fleet-hosted profile to
// replace - comes from the dashboard's own MDM lockdown table (each row
// already carries the real profile_uuid from /api/host-status), never
// typed in by hand. Fleet itself rejects a replacement whose
// PayloadIdentifier doesn't match the existing profile's - see
// fleetClient.ts's updateConfigurationProfile doc comment for why this
// Worker doesn't duplicate that check itself.
export async function handleUpdateConfigProfile(profileUuid: string, request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "expected multipart/form-data body" }, 400);
  }
  if (!formData.get("profile")) {
    return jsonResponse({ error: "missing required 'profile' file field" }, 400);
  }

  const result = await updateConfigurationProfile(env, profileUuid, formData);
  return jsonResponse(result, 200);
}
