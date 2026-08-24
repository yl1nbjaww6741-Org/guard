// Auth helpers for the dashboard API. General access to /api/... routes
// is gated by Cloudflare Access (see cloudflareAccess.ts) - this file is
// left with only the ratchet's second, distinct gate: the loosen-request
// password check.

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
