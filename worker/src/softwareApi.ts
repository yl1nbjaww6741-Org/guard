// Route handlers for the software-deployment API (/api/software/...) -
// the dashboard's ".pkg deployment via Fleet" surface from
// mac/README.md's Phase 4 scope decision. Thin wrappers around
// fleetClient.ts + db.ts, same separation as ratchet.ts/santaSync.ts.

import { findHostId, installOnHost, uploadPackage } from "./fleetClient";
import { listSoftwarePackages, recordUploadedPackage } from "./db";
import type { Env } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Expects a multipart/form-data request body already shaped for Fleet's
// own "Add package" endpoint (see fleetClient.ts's top comment) - this
// Worker passes the incoming FormData straight through rather than
// reconstructing it, so every field Fleet's API accepts (install_script,
// self_service, labels_include_any, etc.) works here too without this
// file needing to know about each one individually.
export async function handleUploadPackage(request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "expected multipart/form-data body" }, 400);
  }
  if (!formData.get("software")) {
    return jsonResponse({ error: "missing required 'software' file field" }, 400);
  }

  const result = await uploadPackage(env, formData);
  await recordUploadedPackage(env.DB, {
    titleId: result.software_package.title_id,
    name: result.software_package.name,
    version: result.software_package.version,
    platform: result.software_package.platform,
    hashSha256: result.software_package.hash_sha256,
  });
  return jsonResponse(result, 201);
}

export async function handleListSoftwarePackages(env: Env): Promise<Response> {
  return jsonResponse(await listSoftwarePackages(env.DB));
}

// `host` identifies the target host the same way Fleet's own "List
// hosts" `query` parameter does - hostname, serial, UUID, or IP (see
// fleetClient.ts's findHostId). Deliberately not accepting a raw numeric
// Fleet host ID here even though the underlying Fleet API wants one -
// forcing callers through a human-meaningful identifier avoids a
// dashboard silently sending an install to whatever host ID happens to
// be typed in, a stale ID, or the wrong project's host entirely.
export async function handleInstallPackage(titleId: number, request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ host?: string }>();
  if (!body.host) {
    return jsonResponse({ error: "missing required 'host' field (hostname, serial, or UUID)" }, 400);
  }

  const hostId = await findHostId(env, body.host);
  if (hostId === null) {
    return jsonResponse({ error: `no host found matching '${body.host}'` }, 404);
  }

  await installOnHost(env, hostId, titleId);
  // Matches Fleet's own "Install software" response: 202, install
  // happens asynchronously on Fleet's side. This Worker doesn't poll for
  // completion - see fleetClient.ts's doc comment on why that's not
  // wired up yet.
  return jsonResponse({ hostId, titleId, status: "install requested" }, 202);
}
