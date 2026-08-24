// Auth helpers. Two unrelated things live here:
//  - requireSantaSyncToken: gates the Santa sync-protocol endpoints
//    (santaSync.ts) - see its own doc comment for why this exists at all.
//  - verifyLoosenPassword: the ratchet's second, distinct gate on top of
//    Cloudflare Access (cloudflareAccess.ts), which gates general
//    /api/... dashboard access.

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison - real timing-attack resistance matters more
// here than it did for the now-retired API_TOKEN stopgap, since this is
// comparing against the actual credential that gates a real security
// action (loosening a restriction), not just general API access.
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
// hashed like the loosen password - this is a machine-generated,
// machine-compared credential exchanged over TLS, not a human-typed
// password with different reuse-across-contexts risk.
export async function requireSyncToken(request: Request, env: { SANTA_SYNC_TOKEN?: string }): Promise<Response | null> {
  if (!env.SANTA_SYNC_TOKEN) {
    // Fail closed on missing config - an unconfigured sync token should
    // never silently mean "sync is open to anyone."
    return new Response("Sync token not configured", { status: 503 });
  }
  const provided = request.headers.get("X-ContentGuard-Sync-Token") ?? "";
  if (!timingSafeEqual(provided, env.SANTA_SYNC_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// The ratchet's second gate (mac/README.md's Phase 4 row: loosening
// needs "a re-entered password at the moment of that specific action" -
// on top of, not instead of, Cloudflare Access getting you into the
// dashboard at all). Deliberately checked separately from Access's own
// JWT, even though the user has chosen to set `LOOSEN_PASSWORD_HASH` to
// the same real password value as their Access login (their explicit
// call, made for simplicity over the extra friction a genuinely
// different credential would add - see this project's git history for
// the tradeoff as discussed). Whatever value it's set to, this function
// re-checks it independently at the moment of the loosen action, rather
// than trusting that an already-valid Access session is sufficient on its
// own - that's what makes this a second gate at all, not just a
// restatement of the first one.
export async function verifyLoosenPassword(password: string, env: { LOOSEN_PASSWORD_HASH?: string }): Promise<boolean> {
  if (!env.LOOSEN_PASSWORD_HASH) return false; // unconfigured = never passes
  const providedHash = await sha256Hex(password);
  return timingSafeEqual(providedHash, env.LOOSEN_PASSWORD_HASH);
}
