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

import { listSafeAppBundleIds } from "./db";
import type { Env } from "./types";

export async function handleSafeAppsSync(env: Env): Promise<Response> {
  const approved = await listSafeAppBundleIds(env.DB);
  const body = { bundle_ids: approved.map((row) => row.bundle_id) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
