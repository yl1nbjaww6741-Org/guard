// The one endpoint the Chrome extension itself calls - GET /sync/keywords.
// Deliberately unauthenticated, same reasoning as extensionUpdate.ts's
// self-hosted update endpoints (see that file's own doc comment): this
// project is single-user/single-deployment, and the point of this
// endpoint's design (2026-09-04) is that the extension needs ZERO
// per-machine configuration - no options page, no token to generate,
// copy, and paste - it just works the moment it's force-installed,
// fetching from a panel origin (shared/config.js's CONTENTGUARD_PANEL_URL)
// baked into its own source at build time. A per-request secret would
// defeat that entirely - there'd be nowhere to put it that isn't either
// committed to this repo (not a secret at all, then) or re-introducing
// the exact options-page configuration step this design removes.
//
// Accepted, not hidden: this makes the blocked-keyword list itself
// publicly readable by anyone who requests this URL, same as the
// packaged .crx already being a public, unauthenticated download. Real
// tradeoff, but a narrow one - this is read-only (nothing here can
// widen what the extension does, unlike a route that could ever accept
// writes), and the keywords list is already visible to anyone with
// dashboard access; this is not meaningfully more exposed than that,
// and the token this used to require never protected anything else
// dependent on it (see git history: the token itself was baked straight
// into the extension's own inspectable source either way, options.js's
// old doc comment on that exact point).
//
// Same "single plain GET, no cursor/pagination" reasoning as
// daemonSync.ts's handleSafeAppsSync - the keyword list is small and
// dashboard-managed, not something that needs incremental-sync
// complexity.
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
