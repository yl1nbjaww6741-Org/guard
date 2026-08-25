// The one endpoint the Chrome extension itself calls - GET /sync/keywords,
// gated by auth.ts's requireExtensionSyncToken (checked in index.ts before
// this runs, same split as Santa's/the daemon's sync routes). Same
// "single plain GET, no cursor/pagination" reasoning as daemonSync.ts's
// handleSafeAppsSync - the keyword list is small and dashboard-managed,
// not something that needs incremental-sync complexity.
//
// Returns only what's actually been added (blocked_keywords) - a
// pending_keyword_removals row still counts as blocked until its 24h
// delay elapses and ratchet.ts's applyDueKeywordRemovals actually deletes
// the row, so this naturally reflects that without needing to filter
// anything out.

import { listBlockedKeywords } from "./db";
import type { Env } from "./types";

export async function handleKeywordsSync(env: Env): Promise<Response> {
  const blocked = await listBlockedKeywords(env.DB);
  const body = { keywords: blocked.map((row) => row.keyword) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
