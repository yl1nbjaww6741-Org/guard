// Route handlers for the dashboard's keyword-blocklist management
// (/api/keywords/... and /api/keyword-removals/...) - lets the dashboard
// adjust the Chrome extension's keyword blocklist. See
// schema.sql's blocked_keywords/pending_keyword_removals comments for
// the ratchet polarity: adding a keyword is a tightening and applies
// immediately (no password, same as safeAppsApi.ts's sibling being the
// opposite - removing there is immediate, adding here is), removing one
// is a loosening and goes through the same 24h-delay-plus-re-entered-
// password ratchet as everything else on this dashboard.

import { addBlockedKeyword, cancelKeywordRemoval, getDashboardPasswordHash, listActiveKeywordRemovals, listBlockedKeywords } from "./db";
import { verifyPasswordHash } from "./auth";
import { KeywordNotFoundError, KeywordRemovalAlreadyPendingError, requestRemoveKeyword } from "./ratchet";
import type { Env } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleListKeywords(env: Env): Promise<Response> {
  return jsonResponse(await listBlockedKeywords(env.DB));
}

// Tightening - session auth only, no password re-check, same as
// handleCreateRule creating a new BLOCKLIST rule. Trims and lowercases
// so matching (both the extension's declarativeNetRequest rules and its
// content-script text scan, see the extension's own keyword-blocker.js)
// is consistent regardless of how the dashboard user typed it in -
// keyword matching is meant to be case-insensitive, not an exact-string
// test.
export async function handleAddKeyword(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ keyword?: string }>();
  const keyword = body.keyword?.trim().toLowerCase();
  if (!keyword) {
    return jsonResponse({ error: "missing keyword" }, 400);
  }
  await addBlockedKeyword(env.DB, keyword);
  return jsonResponse({ added: true }, 201);
}

export async function handleListPendingKeywordRemovals(env: Env): Promise<Response> {
  return jsonResponse(await listActiveKeywordRemovals(env.DB));
}

// Same re-check pattern as handleLoosenRequest/handleRequestAddSafeApp -
// being logged in already isn't enough to widen what the extension lets
// through.
export async function handleRequestRemoveKeyword(keywordId: number, request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ password?: string }>();
  const storedHash = await getDashboardPasswordHash(env.DB);
  if (!body.password || !storedHash || !(await verifyPasswordHash(body.password, storedHash))) {
    return jsonResponse({ error: "incorrect or missing password" }, 403);
  }

  try {
    const pending = await requestRemoveKeyword(env.DB, keywordId);
    return jsonResponse(pending, 202);
  } catch (error) {
    if (error instanceof KeywordNotFoundError) {
      return jsonResponse({ error: error.message }, 404);
    }
    if (error instanceof KeywordRemovalAlreadyPendingError) {
      return jsonResponse({ error: error.message }, 409);
    }
    throw error;
  }
}

export async function handleCancelKeywordRemoval(id: number, env: Env): Promise<Response> {
  // No password required to cancel - same reasoning as every other
  // cancel-a-loosen endpoint in this project: staying restricted needs
  // no extra friction, only reducing a restriction does.
  await cancelKeywordRemoval(env.DB, id);
  return jsonResponse({ cancelled: true });
}
