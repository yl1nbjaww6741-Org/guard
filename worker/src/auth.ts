// Auth helpers. Three unrelated things live here:
//  - requireSyncToken: gates the Santa sync-protocol endpoints
//    (santaSync.ts) - see its own doc comment for why this exists at all.
//  - hashPassword/verifyPasswordHash: shared password hashing, used by
//    both the dashboard login (session.ts issues a cookie after this
//    passes) and the loosen-request's separate re-check.
//  - requireSession: gates general /api/... dashboard access - replaces
//    the earlier Cloudflare Access approach entirely (see git history
//    and schema.sql's dashboard_auth comment for why).

import { hasValidSession } from "./session";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison - matters for both the sync token and the
// dashboard password hash, which each gate a real security-relevant
// action, not just general noise.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Real, previously-missed gap found live once this Worker was actually
// deployed to a public URL (not caught earlier - this sandbox never had
// a public endpoint to probe): the Santa sync endpoints
// (preflight/eventupload/ruledownload/postflight) had NO authentication
// at all. The reasoning that led there was wrong - "Santa itself calls
// these, not a human" was true of *normal* operation, but says nothing
// about who else *can* call a publicly reachable URL. Confirmed live:
// anyone could POST to /preflight/{any-id} and get a real response,
// creating device rows; worse, /ruledownload would have handed out this
// project's entire denylist (Tor Browser's TeamID, etc.) to anyone who
// asked, unauthenticated.
//
// Fixed using Santa's own real, documented mechanism for this -
// `SyncExtraHeaders` (confirmed via northpole.dev's Configuration: Keys
// reference, not guessed): "Dictionary of additional headers to include
// in all requests made to the sync server." santa-config.mobileconfig
// gets a SyncExtraHeaders entry with a static shared token once
// SyncBaseURL is actually wired up (a separate, deliberate scope
// decision - see PHASE_4_DASHBOARD_SETUP.md), sent as the
// X-ContentGuard-Sync-Token header on every sync request; this function
// checks it server-side. A plain equality-checked static token, not
// hashed like the dashboard password - this is a machine-generated,
// machine-compared credential exchanged over TLS, not a human-typed
// password with different reuse-across-contexts risk.
export async function requireSyncToken(request: Request, env: { SANTA_SYNC_TOKEN?: string }): Promise<Response | null> {
  if (!env.SANTA_SYNC_TOKEN) {
    return new Response("Sync token not configured", { status: 503 });
  }
  const provided = request.headers.get("X-ContentGuard-Sync-Token") ?? "";
  if (!timingSafeEqual(provided, env.SANTA_SYNC_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return sha256Hex(password);
}

export async function verifyPasswordHash(password: string, storedHash: string): Promise<boolean> {
  const providedHash = await hashPassword(password);
  return timingSafeEqual(providedHash, storedHash);
}

// Gates general dashboard/API access (index.ts's /api/... routes and
// GET /). Replaces requireCloudflareAccess entirely - see this file's
// git history for the tradeoff that decision accepts (no edge-level
// blocking; db.ts's login-lockout functions are the mitigation for
// that, checked separately in the login handler itself, not here).
export async function requireSession(request: Request, env: { SESSION_SIGNING_KEY?: string }): Promise<Response | null> {
  if (!env.SESSION_SIGNING_KEY) {
    return new Response("Session signing key not configured", { status: 503 });
  }
  const valid = await hasValidSession(request, env.SESSION_SIGNING_KEY);
  return valid ? null : new Response("Unauthorized", { status: 401 });
}
