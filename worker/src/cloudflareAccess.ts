// Verifies Cloudflare Access JWTs for the rule-management/software-
// deployment API - built against Cloudflare's own documented method
// (developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/),
// not guessed. This is defense-in-depth: the real access-control
// boundary is the Access Application itself, configured in Cloudflare's
// Zero Trust dashboard to sit in front of this Worker's route (see
// mac/docs/PHASE_4_DASHBOARD_SETUP.md's setup steps) - unauthenticated
// requests should never reach this code at all. Verifying the JWT here
// too means a misconfigured or bypassed edge doesn't silently leave
// these routes open.
//
// Replaces auth.ts's earlier requireApiToken stopgap entirely, not
// layered alongside it - a Cloudflare-signed, per-session JWT is a
// strictly stronger check than a static shared bearer token, so keeping
// both would add complexity without adding real security. Fails closed
// by design: with no Access Application configured yet (real deployment
// hasn't happened - see PHASE_4_DASHBOARD_SETUP.md), there is no valid
// JWT to present, so every request to these routes is correctly rejected
// until Access is actually set up. That's intentional, not a bug to
// work around before deployment.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

// Cached across requests within the same Worker isolate - createRemoteJWKSet
// itself handles re-fetching keys on a `kid` cache miss (e.g. after
// Cloudflare rotates its signing key), so this doesn't need manual
// invalidation logic.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedForTeamDomain: string | null = null;

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks && cachedForTeamDomain === teamDomain) return cachedJwks;
  cachedJwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  cachedForTeamDomain = teamDomain;
  return cachedJwks;
}

// Returns null if the request is authorized, or a Response to return
// immediately if not - same calling convention as auth.ts's
// requireApiToken had, so index.ts's route-gating logic didn't need to
// change shape when this replaced it.
export async function requireCloudflareAccess(request: Request, env: Env): Promise<Response | null> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    // Fail closed on missing config, not open - same principle as
    // auth.ts's verifyLoosenPassword. An unconfigured Access setup
    // should never silently mean "no auth required".
    // 503, not 500 - this is "not ready yet" (missing config), not a
    // server error.
    return new Response("Cloudflare Access not configured", { status: 503 });
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    await jwtVerify(token, getJwks(env.CF_ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: env.CF_ACCESS_AUD,
    });
    return null;
  } catch (error) {
    // Any verification failure (bad signature, expired, wrong aud/iss,
    // malformed token) is just "unauthorized" from the caller's
    // perspective - the specific reason is logged server-side for
    // debugging, never leaked to the response.
    console.error("Cloudflare Access JWT verification failed:", error);
    return new Response("Unauthorized", { status: 401 });
  }
}
