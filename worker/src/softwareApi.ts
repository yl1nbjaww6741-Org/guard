// Route handlers for the software-deployment API (/api/software/...) -
// the dashboard's ".pkg deployment via Fleet" surface from
// mac/README.md's Phase 4 scope decision. Thin wrappers around
// fleetClient.ts + db.ts, same separation as ratchet.ts/santaSync.ts.

import { findHostId, getHostSoftware, installOnHost, uploadPackage } from "./fleetClient";
import { listSoftwarePackages, recordUploadedPackage } from "./db";
import type { Env, FleetHostSoftwareItem, RuleType } from "./types";

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

export interface InstalledSoftwareRow {
  name: string;
  version: string | null;
  bundle_identifier: string | null;
  // null when Fleet has no usable code-signing identifier for this app
  // yet (e.g. hasn't been queried recently, or isn't a signed macOS
  // .app) - the dashboard disables the Block/Allow buttons for that row
  // rather than sending a request that can only fail.
  identifier: string | null;
  rule_type: RuleType | null;
}

// Preference order matches this project's own existing pattern (Tor
// Browser's rule is TEAMID, not a hash) - a Team ID rule survives the
// app updating itself, a hash-based one doesn't. CDHASH before BINARY
// since Fleet's `hash_sha256` field is actually a cdhash_sha256 (see
// types.ts's FleetSignatureInfo comment) and is more commonly populated
// than `executable_sha256` in Fleet's current data.
function pickIdentifier(item: FleetHostSoftwareItem): { identifier: string; rule_type: RuleType } | null {
  const sig = item.installed_versions?.[0]?.signature_information?.[0];
  if (!sig) return null;
  if (sig.team_identifier) return { identifier: sig.team_identifier, rule_type: "TEAMID" };
  if (sig.hash_sha256) return { identifier: sig.hash_sha256, rule_type: "CDHASH" };
  if (sig.executable_sha256) return { identifier: sig.executable_sha256, rule_type: "BINARY" };
  return null;
}

// Surfaces Fleet's own osquery-based software inventory for a host -
// see fleetClient.ts's getHostSoftware doc comment for why (avoids the
// user needing to manually `codesign -dv` in Terminal the way Tor
// Browser's original Phase 3 rule was found). Same host-resolution rule
// as handleInstallPackage: a human-meaningful identifier only, never a
// raw Fleet host ID from a caller.
export async function handleListInstalledSoftware(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = url.searchParams.get("host");
  if (!host) {
    return jsonResponse({ error: "missing required 'host' query parameter (hostname, serial, or UUID)" }, 400);
  }

  const hostId = await findHostId(env, host);
  if (hostId === null) {
    return jsonResponse({ error: `no host found matching '${host}'` }, 404);
  }

  const software = await getHostSoftware(env, hostId);
  const rows: InstalledSoftwareRow[] = software.map((item) => {
    const picked = pickIdentifier(item);
    const version = item.installed_versions?.[0];
    return {
      name: item.name,
      version: version?.version ?? null,
      bundle_identifier: version?.bundle_identifier ?? null,
      identifier: picked?.identifier ?? null,
      rule_type: picked?.rule_type ?? null,
    };
  });
  return jsonResponse(rows);
}
