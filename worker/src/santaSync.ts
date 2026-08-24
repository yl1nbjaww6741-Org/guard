// Handlers for Santa's 4-stage sync protocol (preflight, eventupload,
// ruledownload, postflight), built against northpolesec/protos'
// sync/v1.proto - cloned and read directly, not guessed. See that file's
// `service SantaSync` block for the real URL pattern each stage uses:
// POST /{stage}/{machine_id}, body "*" (the whole request is the JSON
// body - machine_id appears in both the URL and the body per the proto,
// this Worker trusts the URL's copy since that's what routes the
// request, and cross-checks it matches the body's copy defensively).

import {
  getDeviceClientMode,
  getUnsyncedRulesForDevice,
  markPostflight,
  markRulesSynced,
  recordEvents,
  upsertDevice,
} from "./db";
import type {
  Env,
  EventUploadRequest,
  EventUploadResponse,
  PostflightRequest,
  PostflightResponse,
  PreflightRequest,
  PreflightResponse,
  RuleDownloadRequest,
  RuleDownloadResponse,
} from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Real, previously-missed gap: Santa's own SyncClientContentEncoding
// config key defaults to "deflate" (confirmed directly in
// northpolesec/santa's docs/src/lib/santaconfig.ts, not guessed) - every
// sync request Santa sends is deflate-compressed by default, with a
// matching Content-Encoding header. Cloudflare Workers' Request object
// does NOT auto-decompress an incoming request body based on that
// header (unlike some client-side fetch() response handling) - a plain
// `request.json()` on a compressed body throws a JSON parse error,
// which index.ts's catch-all turns into an opaque 500 "Internal Server
// Error". This was invisible to every local/curl-based test in this
// project's history since curl doesn't compress bodies by default - it
// only surfaced once tested against a real Santa client for the first
// time. Handles "gzip" too since it's a documented alternative value
// for the same config key; "deflate" maps to the Web Compression
// Streams API's "deflate" format (zlib-wrapped, RFC 1950/1951), not
// "deflate-raw" - matches what Content-Encoding: deflate means over
// HTTP.
async function parseJsonBody<T>(request: Request): Promise<T> {
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (!request.body || (encoding !== "deflate" && encoding !== "gzip")) {
    return request.json<T>();
  }
  const decompressed = request.body.pipeThrough(new DecompressionStream(encoding));
  const text = await new Response(decompressed).text();
  return JSON.parse(text) as T;
}

// Every stage's URL includes machine_id (see the proto's `google.api.http`
// annotations) - if it doesn't match the body's own machine_id field,
// something is wrong (a misconfigured client, or a request that's been
// tampered with in transit) and the request is rejected rather than
// silently trusting whichever value seems more convenient.
function machineIdMismatch(urlMachineId: string, bodyMachineId: string | undefined): boolean {
  return bodyMachineId !== undefined && bodyMachineId !== "" && bodyMachineId !== urlMachineId;
}

export async function handlePreflight(machineId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<PreflightRequest>(request);
  if (machineIdMismatch(machineId, body.machine_id)) {
    return jsonResponse({ error: "machine_id in URL and body disagree" }, 400);
  }

  await upsertDevice(env.DB, machineId, {
    hostname: body.hostname,
    osVersion: body.os_version,
    osBuild: body.os_build,
    modelIdentifier: body.model_identifier,
    santaVersion: body.santa_version,
    primaryUser: body.primary_user,
  });

  const clientMode = await getDeviceClientMode(env.DB, machineId);

  const response: PreflightResponse = {
    client_mode: clientMode,
    // Default batch_size from the proto's own comment ("If the server
    // doesn't specify, the default is 50") - set explicitly rather than
    // omitted, since this project's rule set is small and there's no
    // reason to rely on Santa's own fallback when being explicit costs
    // nothing.
    batch_size: 50,
  };
  return jsonResponse(response);
}

export async function handleEventUpload(machineId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<EventUploadRequest>(request);
  if (machineIdMismatch(machineId, body.machine_id)) {
    return jsonResponse({ error: "machine_id in URL and body disagree" }, 400);
  }

  await recordEvents(env.DB, machineId, body.events ?? []);

  // No bundle scanning support yet (enable_bundles isn't set in
  // PreflightResponse, so Santa won't send bundle-related data anyway) -
  // always an empty list.
  const response: EventUploadResponse = { event_upload_bundle_binaries: [] };
  return jsonResponse(response);
}

export async function handleRuleDownload(machineId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<RuleDownloadRequest>(request);
  if (machineIdMismatch(machineId, body.machine_id)) {
    return jsonResponse({ error: "machine_id in URL and body disagree" }, 400);
  }

  const cursorOffset = body.cursor ? Number.parseInt(body.cursor, 10) : 0;
  const { rules, ruleIds, nextCursor } = await getUnsyncedRulesForDevice(
    env.DB,
    machineId,
    Number.isNaN(cursorOffset) ? 0 : cursorOffset
  );

  // Mark synced now, not after Postflight confirms receipt - matches
  // this Worker's own tradeoff, documented here rather than silently
  // assumed: if a client crashes between RuleDownload and Postflight, a
  // rule could be marked synced without Santa having actually applied
  // it. Acceptable for a small hand-maintained rule set with infrequent
  // changes (a missed rule would just get corrected on the next manual
  // dashboard action, which re-marks it unsynced), not acceptable if this
  // ever needs to guarantee delivery - revisit if that changes.
  await markRulesSynced(env.DB, ruleIds);

  const response: RuleDownloadResponse = {
    rules,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
  return jsonResponse(response);
}

export async function handlePostflight(machineId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<PostflightRequest>(request);
  if (machineIdMismatch(machineId, body.machine_id)) {
    return jsonResponse({ error: "machine_id in URL and body disagree" }, 400);
  }

  await markPostflight(env.DB, machineId);

  const response: PostflightResponse = {};
  return jsonResponse(response);
}
