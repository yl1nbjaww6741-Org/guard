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

import { findDeviceId, getInstalledApps, pushApps, uploadAppFromStream } from "./simpleMdmClient";
import { listSoftwarePackages, recordUploadedPackage } from "./db";
import type { Env, RuleType } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Upload is a 3-step R2-multipart-backed flow, not a single request
// carrying the whole file - see simpleMdmClient.ts's
// buildStreamingMultipartBody doc comment for the two real ceilings
// (Cloudflare's 100MB incoming-request-body limit and a Worker's own
// ~128MB memory limit) this replaced. Real bug found live (2026-09-04):
// the old single-POST `software` FormData field silently failed for
// any .pkg over ~100MB - Cloudflare's edge rejects the oversized
// request before this Worker's own code even runs, so there was
// nothing server-side to fix; the dashboard's upload button just did
// nothing, no error surfaced anywhere (see dashboard.ts's upload-form
// handler history for the client-side half of this fix - chunking +
// visible progress).
//
// Flow: init (create an R2 multipart upload) -> N parts (the
// dashboard slices the file client-side and PUTs each slice, well
// under any size limit regardless of total file size) -> complete
// (reassemble in R2, then stream straight from R2 into SimpleMDM's
// /apps endpoint without ever buffering the whole file in this
// Worker's memory).
//
// R2 keys live under a `software-uploads/` prefix in the same bucket
// EXTENSION_ASSETS already binds (contentguard-extension) - a second
// bucket would mean a second Cloudflare R2 permission grant on the
// deploy token for no real benefit at this project's scale (see
// wrangler.toml's own EXTENSION_ASSETS history for how much friction
// that grant took the first time).
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-200);
}

function requireR2(env: Env): R2Bucket {
  if (!env.EXTENSION_ASSETS) throw new Error("EXTENSION_ASSETS R2 binding not configured");
  return env.EXTENSION_ASSETS;
}

export async function handleUploadInit(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ filename?: string }>().catch(() => ({}) as { filename?: string });
  if (!body.filename) return jsonResponse({ error: "missing required 'filename' field" }, 400);

  const key = `software-uploads/${Date.now()}-${sanitizeFilename(body.filename)}`;
  const upload = await requireR2(env).createMultipartUpload(key);
  return jsonResponse({ key: upload.key, uploadId: upload.uploadId });
}

// One chunk's raw bytes as the request body (not multipart - the
// dashboard sends a plain Blob slice per part), addressed by
// key/uploadId/partNumber query params. R2 requires every part but the
// last to be >= 5MB (confirmed against Cloudflare's own R2 multipart
// docs) - dashboard.ts's chunk size is picked comfortably above that.
export async function handleUploadPart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!key || !uploadId || !partNumber) {
    return jsonResponse({ error: "missing required 'key'/'uploadId'/'partNumber' query params" }, 400);
  }

  const chunk = await request.arrayBuffer();
  const upload = requireR2(env).resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, chunk);
  return jsonResponse({ partNumber: part.partNumber, etag: part.etag });
}

export async function handleUploadComplete(request: Request, env: Env): Promise<Response> {
  const body = await request
    .json<{ key?: string; uploadId?: string; parts?: { partNumber: number; etag: string }[]; filename?: string }>()
    .catch(() => ({}) as { key?: string; uploadId?: string; parts?: { partNumber: number; etag: string }[]; filename?: string });
  if (!body.key || !body.uploadId || !body.parts?.length || !body.filename) {
    return jsonResponse({ error: "missing required 'key'/'uploadId'/'parts'/'filename' fields" }, 400);
  }

  const bucket = requireR2(env);
  const upload = bucket.resumeMultipartUpload(body.key, body.uploadId);
  await upload.complete(body.parts);

  // `complete()`'s own return doesn't carry a readable body (it's R2
  // object metadata only, confirmed against Cloudflare's R2 multipart
  // docs) - re-`get` the now-assembled object to stream it onward.
  const stored = await bucket.get(body.key);
  if (!stored) return jsonResponse({ error: "uploaded object went missing after complete" }, 500);

  let result: { id: string; name: string; version?: string };
  try {
    result = await uploadAppFromStream(env, stored.body, stored.size, body.filename);
  } finally {
    // Best-effort cleanup - this bucket is scratch space for in-flight
    // uploads, not long-term storage for the .pkg itself (SimpleMDM
    // holds the real copy once uploaded). Leaving a stale object behind
    // on a failed SimpleMDM upload isn't worth failing the whole
    // request over.
    await bucket.delete(body.key).catch(() => undefined);
  }

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

// Best-effort cancel - called by the dashboard when a chunk upload
// fails partway through, so an abandoned multipart upload doesn't sit
// in R2 forever. Not calling this on failure wouldn't break anything
// user-visible, just leave scratch storage behind, so errors here are
// swallowed rather than surfaced.
export async function handleUploadAbort(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ key?: string; uploadId?: string }>().catch(() => ({}) as { key?: string; uploadId?: string });
  if (body.key && body.uploadId) {
    await requireR2(env)
      .resumeMultipartUpload(body.key, body.uploadId)
      .abort()
      .catch(() => undefined);
  }
  return jsonResponse({ aborted: true });
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
