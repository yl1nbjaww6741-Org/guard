// Route handlers for the dashboard's safe-app-bundle-ID management
// (/api/safe-apps/... and /api/safe-app-additions/...) - lets the
// dashboard adjust ContentGuardDaemon's capture-scope whitelist
// (safe_app_bundle_ids) without a source edit + recompile + codesign +
// `sudo make install`. See schema.sql's safe_app_bundle_ids comment for
// why this exists and what it does and doesn't replace.
//
// Adding a bundle ID is a loosening and goes through the same 24h-delay-
// plus-re-entered-password ratchet as everything else on this dashboard
// (ratchet.ts's requestAddSafeApp/applyDueSafeAppAdditions) - this file
// only re-checks the password and queues the request, same shape as
// configProfilesApi.ts. Removing a bundle ID is a tightening and applies
// immediately, same asymmetry as rules/upsertRule.

import { cancelSafeAppAddition, getDashboardPasswordHash, listActiveSafeAppAdditions, listSafeAppBundleIds, removeSafeAppBundleId } from "./db";
import { verifyPasswordHash } from "./auth";
import { SafeAppAdditionAlreadyPendingError, SafeAppAlreadyApprovedError, requestAddSafeApp } from "./ratchet";
import { STATIC_SAFE_APPS } from "./staticSafeApps";
import type { Env } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleListSafeApps(env: Env): Promise<Response> {
  return jsonResponse(await listSafeAppBundleIds(env.DB));
}

// The compiled baseline (Config.swift, mirrored by hand - see
// staticSafeApps.ts's doc comment) - purely for dashboard visibility, no
// create/edit/delete here, same as handleListStaticRules in index.ts.
export function handleListStaticSafeApps(): Response {
  return jsonResponse(STATIC_SAFE_APPS);
}

// Same re-check pattern as handleLoosenRequest/handlePasswordChangeRequest
// in index.ts - being logged in already isn't enough to widen a blind
// spot in what gets scanned.
export async function handleRequestAddSafeApp(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ bundle_id?: string; name?: string; password?: string }>();
  const bundleId = body.bundle_id?.trim();
  if (!bundleId) {
    return jsonResponse({ error: "missing bundle_id" }, 400);
  }

  const storedHash = await getDashboardPasswordHash(env.DB);
  if (!body.password || !storedHash || !(await verifyPasswordHash(body.password, storedHash))) {
    return jsonResponse({ error: "incorrect or missing password" }, 403);
  }

  try {
    const pending = await requestAddSafeApp(env.DB, bundleId, body.name?.trim() || null);
    return jsonResponse(pending, 202);
  } catch (error) {
    if (error instanceof SafeAppAlreadyApprovedError || error instanceof SafeAppAdditionAlreadyPendingError) {
      return jsonResponse({ error: error.message }, 409);
    }
    throw error;
  }
}

export async function handleListPendingSafeAppAdditions(env: Env): Promise<Response> {
  return jsonResponse(await listActiveSafeAppAdditions(env.DB));
}

export async function handleCancelSafeAppAddition(id: number, env: Env): Promise<Response> {
  // No password required to cancel - same reasoning as every other
  // cancel-a-loosen endpoint in this project: staying restricted needs
  // no extra friction, only reducing a restriction does.
  await cancelSafeAppAddition(env.DB, id);
  return jsonResponse({ cancelled: true });
}

// Tightening - immediate, no password, no queue. Removing a bundle ID
// that was never approved (or was already removed) is a harmless no-op,
// same as db.ts's removeSafeAppBundleId itself.
export async function handleRemoveSafeApp(bundleId: string, env: Env): Promise<Response> {
  await removeSafeAppBundleId(env.DB, bundleId);
  return jsonResponse({ removed: true });
}
