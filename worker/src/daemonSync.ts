// The one endpoint ContentGuardDaemon itself calls - GET /sync/safe-apps,
// gated by auth.ts's requireDaemonSyncToken (checked in index.ts before
// this runs, same split as Santa's sync routes). Deliberately a single
// plain GET, not a multi-stage protocol like Santa's preflight/ruledownload/
// postflight - this project's whole safe-app list is small and
// hand-maintained (same "minimal moving parts" reasoning as staticRules.ts),
// so there's no cursor/pagination/incremental-sync complexity worth
// building for it.
//
// Returns only what's actually been approved (safe_app_bundle_ids) - never
// what's still pending a ratchet delay (pending_safe_app_additions). The
// daemon has no way to tell the difference between "approved" and "still
// queued" from this response alone, by design: it shouldn't need to, since
// only approved entries are ever sent.

import { listSafeAppBundleIds, replaceAppInventory } from "./db";
import type { Env } from "./types";

export async function handleSafeAppsSync(env: Env): Promise<Response> {
  const approved = await listSafeAppBundleIds(env.DB);
  const body = { bundle_ids: approved.map((row) => row.bundle_id) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// The daemon's own POST counterpart to the GET above - opposite
// direction, same trust boundary (requireDaemonSyncToken, checked in
// index.ts before this runs). AppInventoryScanner/AppInventorySyncClient
// (daemon-side Swift) report every .app they found under /Applications
// plus its real Team ID; see migrations/0008_app_inventory.sql's own
// comment for why this can only ever come from the Mac itself, never
// from SimpleMDM's API.
//
// A full replace on every sync, not an incremental add - see
// db.ts's replaceAppInventory for the prune-of-uninstalled-apps
// reasoning. The daemon always reports its complete current scan, never
// a diff, so this is the only correct semantics: an app missing from
// this request really was uninstalled, not merely "not mentioned this
// time."
export async function handleAppInventorySync(request: Request, env: Env): Promise<Response> {
  let body: { apps?: { bundle_id?: string; name?: string; team_id?: string; path?: string }[] };
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }
  const rawApps = Array.isArray(body.apps) ? body.apps : [];
  // Same "fail loudly on a malformed request" reasoning as the Santa
  // sync stages above - a bundle_id-less entry is a real bug in the
  // scanner, not a shape this endpoint should silently tolerate.
  if (rawApps.some((a) => !a.bundle_id)) {
    return new Response("Bad Request: every app entry needs a bundle_id", { status: 400 });
  }
  const apps = rawApps.map((a) => ({
    bundleId: a.bundle_id!,
    name: a.name,
    teamId: a.team_id,
    path: a.path,
  }));
  await replaceAppInventory(env.DB, apps);
  return new Response(JSON.stringify({ synced: apps.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
