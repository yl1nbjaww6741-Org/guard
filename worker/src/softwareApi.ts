// Route handlers for the software-deployment API (/api/software/...) -
// the dashboard's ".pkg deployment via MDM" surface from mac/README.md's
// Phase 4 scope decision. Thin wrappers around simpleMdmClient.ts + db.ts,
// same separation as ratchet.ts/santaSync.ts.
//
// Migrated off fleetClient.ts to simpleMdmClient.ts (see
// mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md) - two real,
// structural differences from the Fleet-backed version this replaces,
// both documented in simpleMdmClient.ts's own top comment:
//   1. No per-title targeted install - handleInstallPackage below now
//      pushes everything currently assigned to the host, not just the
//      one titleId in the URL (accepted trade-off at this project's
//      single-device scale).
//   2. handleListInstalledSoftware's rows always have identifier/
//      rule_type null now - SimpleMDM's installed_apps doesn't expose
//      per-app Team ID/cdhash the way Fleet's signature_information
//      did, so the dashboard's one-click "create a Santa rule from this
//      installed app" action has nothing to build a rule from anymore.
//      The row still displays; the button it used to enable doesn't.

import { findDeviceId, getInstalledApps, pushApps, uploadApp } from "./simpleMdmClient";
import { listSoftwarePackages, recordUploadedPackage } from "./db";
import type { Env, RuleType } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Expects a multipart/form-data request body with a `software` file
// field - this Worker's own long-standing upload contract (predates the
// SimpleMDM migration), translated internally by
// simpleMdmClient.ts's uploadApp into SimpleMDM's real required field
// name (`binary`) rather than changing the dashboard's own form.
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

  const result = await uploadApp(env, formData);
  await recordUploadedPackage(env.DB, {
    titleId: Number(result.id),
    name: result.name,
    version: result.version,
    // SimpleMDM's app-upload response doesn't carry a platform string
    // or a package hash the way Fleet's did - this project only ever
    // uploads macOS packages, so platform is hardcoded rather than left
    // blank; hashSha256 stays unset (recordUploadedPackage's own
    // signature already treats it as optional).
    platform: "darwin",
  });
  return jsonResponse(result, 201);
}

export async function handleListSoftwarePackages(env: Env): Promise<Response> {
  return jsonResponse(await listSoftwarePackages(env.DB));
}

// `host` identifies the target device the same way SimpleMDM's own
// device-search `search` parameter does - name, UDID, serial, IMEI,
// MAC, or phone number (see simpleMdmClient.ts's findDeviceId).
// Deliberately not accepting a raw numeric SimpleMDM device ID here
// even though the underlying API wants one - forcing callers through a
// human-meaningful identifier avoids a dashboard silently sending an
// install to whatever device ID happens to be typed in, a stale ID, or
// the wrong project's device entirely.
//
// `titleId` is accepted for route-shape/URL-compatibility with the
// dashboard's existing "Install" button per software row, but SimpleMDM
// has no per-title targeted install - see this file's top comment and
// simpleMdmClient.ts's pushApps doc comment. This call installs
// everything currently assigned to the device that isn't installed
// yet, not just `titleId` specifically.
export async function handleInstallPackage(titleId: number, request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ host?: string }>();
  if (!body.host) {
    return jsonResponse({ error: "missing required 'host' field (hostname, serial, or UUID)" }, 400);
  }

  const deviceId = await findDeviceId(env, body.host);
  if (deviceId === null) {
    return jsonResponse({ error: `no device found matching '${body.host}'` }, 404);
  }

  await pushApps(env, deviceId);
  return jsonResponse(
    { hostId: deviceId, titleId, status: "install requested (all assigned apps, not just this title - see simpleMdmClient.ts)" },
    202
  );
}

export interface InstalledSoftwareRow {
  name: string;
  version: string | null;
  bundle_identifier: string | null;
  // Always null now, post-SimpleMDM-migration - see this file's top
  // comment. SimpleMDM's installed_apps has no per-app code-signing
  // Team ID/cdhash the way Fleet's signature_information did, so
  // there's nothing to build a Santa rule identifier from anymore. The
  // dashboard still shows the row; it disables the Block/Allow buttons
  // whenever identifier is null, same as it always did for an app Fleet
  // hadn't queried signature info for yet - the behavior is identical,
  // it's just permanent now instead of transient.
  identifier: string | null;
  rule_type: RuleType | null;
}

// Surfaces SimpleMDM's real app inventory for a device - see
// simpleMdmClient.ts's getInstalledApps doc comment for why this can no
// longer back the "create a Santa rule from this installed app"
// one-click action Fleet's signature_information used to enable. Same
// host-resolution rule as handleInstallPackage: a human-meaningful
// identifier only, never a raw SimpleMDM device ID from a caller. Falls
// back to DEFAULT_SIMPLEMDM_DEVICE_ID (types.ts) when no explicit
// `host` is given - this project only has one real Mac in scope right
// now, so requiring it be typed in every time is friction, not a
// safeguard; an explicit `host` still always overrides it.
export async function handleListInstalledSoftware(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const explicitHost = url.searchParams.get("host");
  const host = explicitHost || env.DEFAULT_SIMPLEMDM_DEVICE_ID;
  if (!host) {
    return jsonResponse(
      { error: "missing required 'host' query parameter (hostname, serial, or UUID) - or set DEFAULT_SIMPLEMDM_DEVICE_ID" },
      400
    );
  }

  // DEFAULT_SIMPLEMDM_DEVICE_ID is already a numeric SimpleMDM device
  // id - only a caller-supplied `host` (name/serial/etc.) needs
  // resolving via findDeviceId's search, same pattern as hostStatus.ts.
  const deviceId = explicitHost ? await findDeviceId(env, host) : Number(host);
  if (deviceId === null || Number.isNaN(deviceId)) {
    return jsonResponse({ error: `no device found matching '${host}'` }, 404);
  }

  const software = await getInstalledApps(env, deviceId);
  const rows: InstalledSoftwareRow[] = software.map((item) => ({
    name: item.name,
    version: item.version,
    bundle_identifier: item.bundleIdentifier,
    identifier: null,
    rule_type: null,
  }));
  return jsonResponse(rows);
}
