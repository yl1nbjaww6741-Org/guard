// Auth helpers for the (not-yet-built) dashboard API. Cloudflare Access
// isn't wired in yet (see mac/docs/PHASE_4_DASHBOARD_SETUP.md's "not
// built yet" list) - until it is, these are the only thing standing
// between the rule-management endpoints and the open internet, so this
// file exists specifically to make sure that gap is never silent. Every
// rule-management route in index.ts calls `requireApiToken` before doing
// anything, deliberately, rather than assuming Cloudflare Access will
// always be in front of it by the time this is ever actually deployed.

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish string comparison - real timing-attack resistance
// matters less here than in, say, comparing raw passwords (we're already
// comparing hex-encoded hashes, and the interim API_TOKEN check below is
// a stopgap, not the final auth story), but there's no cost to doing it
// properly instead of `===`.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Interim, stopgap check for the rule-management API - a single shared
// token (set via `wrangler secret put API_TOKEN`), checked against a
// bearer header. This is NOT the real access-control story for this
// project (that's Cloudflare Access, per mac/README.md's Phase 4 row -
// reusing the existing Zero Trust instance from Phase 1) - it exists
// only so these endpoints aren't wide open to the internet in the gap
// between "this Worker is deployed" and "Access is actually configured
// in front of it". Replace/supplement with real Access JWT verification
// before this ever handles a real dashboard's traffic.
export async function requireApiToken(request: Request, env: { API_TOKEN?: string }): Promise<Response | null> {
  if (!env.API_TOKEN) {
    // No token configured at all - fail closed, not open. An
    // unconfigured secret should never silently mean "no auth required".
    return new Response("API_TOKEN not configured", { status: 500 });
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!timingSafeEqual(provided, env.API_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null; // null = authorized, caller proceeds
}

// The ratchet's second, distinct gate (mac/README.md's Phase 4 row:
// loosening needs "a re-entered password at the moment of that specific
// action" - on top of, not instead of, whatever gets you into the
// dashboard/API at all via requireApiToken/Access). Deliberately a
// separate secret (`LOOSEN_PASSWORD_HASH`, stored as a SHA-256 hex
// digest, never the raw password) from anything that gates general
// access - what exactly this password should be (a second personal
// password, or the same credentials Phase 5 plans to seal in a vault)
// hasn't been decided, same open-question treatment as the
// StaticRules-vs-sync question in PHASE_4_DASHBOARD_SETUP.md.
export async function verifyLoosenPassword(password: string, env: { LOOSEN_PASSWORD_HASH?: string }): Promise<boolean> {
  if (!env.LOOSEN_PASSWORD_HASH) return false; // unconfigured = never passes
  const providedHash = await sha256Hex(password);
  return timingSafeEqual(providedHash, env.LOOSEN_PASSWORD_HASH);
}
