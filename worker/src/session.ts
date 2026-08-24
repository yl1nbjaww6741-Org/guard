// Dashboard session cookies - replaces Cloudflare Access's own session
// handling now that Access has been dropped in favor of a password gate
// built directly into this Worker (see schema.sql's dashboard_auth
// comment for the reasoning, and this project's git history for the
// tradeoff that decision accepts: no edge-level blocking, mitigated by
// db.ts's login lockout).
//
// Stateless, HMAC-signed tokens (SESSION_SIGNING_KEY) rather than a
// sessions table - nothing to look up or clean up, and there's exactly
// one legitimate session type in this whole system (no per-user data
// needed in the token beyond an expiry).

const COOKIE_NAME = "cg_session";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24h - matches the
// duration Cloudflare Access itself defaulted to when this project
// briefly used it; no reason to pick a different number now.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(payload: string, key: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function createSessionCookie(sessionSigningKey: string): Promise<string> {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_DURATION_MS });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await importSigningKey(sessionSigningKey);
  const signatureB64 = await sign(payloadB64, key);
  const token = `${payloadB64}.${signatureB64}`;
  // HttpOnly: never readable by the dashboard's own JS (defends against
  // XSS stealing the session, not that this page currently renders any
  // untrusted content, but no reason to make the cookie readable anyway).
  // Secure: only sent over HTTPS, which is all a workers.dev/Access
  // deployment ever is anyway.
  // SameSite=Strict: never sent on a cross-site request - this dashboard
  // has no legitimate cross-site use.
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function hasValidSession(request: Request, sessionSigningKey: string): Promise<boolean> {
  const token = getCookieValue(request, COOKIE_NAME);
  if (!token) return false;
  const [payloadB64, signatureB64] = token.split(".");
  if (!payloadB64 || !signatureB64) return false;

  const key = await importSigningKey(sessionSigningKey);
  const expectedSignatureB64 = await sign(payloadB64, key);
  // Signature comparison via the Web Crypto verify primitive would be
  // marginally more idiomatic, but a direct constant-time compare of
  // the two base64url strings is simpler and equally correct here -
  // both are fixed-length, fully-attacker-visible-anyway HMAC outputs,
  // not secrets being compared against a secret.
  if (signatureB64.length !== expectedSignatureB64.length) return false;
  let diff = 0;
  for (let i = 0; i < signatureB64.length; i++) {
    diff |= signatureB64.charCodeAt(i) ^ expectedSignatureB64.charCodeAt(i);
  }
  if (diff !== 0) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as { exp: number };
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}
