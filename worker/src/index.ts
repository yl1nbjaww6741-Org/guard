// ContentGuard control-panel Worker - entry point.
//
// Three route groups:
//  - Santa's 4 sync-protocol stages (santaSync.ts) - gated by a static
//    shared token (auth.ts's requireSyncToken), not the dashboard's
//    password/session system: Santa itself calls these, and a
//    human-typed-password/cookie model doesn't fit a macOS sync client.
//    Found live, the hard way, that this needs *some* gate - see
//    requireSyncToken's own doc comment for what was wrong before and why.
//  - The rule-management/software-deployment API (/api/...) - meant for
//    the dashboard, gated by a session cookie (auth.ts's requireSession).
//    Cloudflare Access was tried first and abandoned - see git history
//    and schema.sql's dashboard_auth comment for why.
//  - GET / - the dashboard page itself (dashboard.ts). Unlike the other
//    two groups, this route never hard-blocks with a 401: it renders
//    whichever of the login page or the real dashboard matches whether
//    the request already carries a valid session, same as the Android
//    sibling app's pattern this whole design is modeled on.

import { hashPassword, requireSession, requireSyncToken, verifyPasswordHash } from "./auth";
import { renderDashboard, renderLoginPage } from "./dashboard";
import {
  cancelLoosenRequest,
  cancelPasswordChange,
  clearFailedLoginAttempts,
  getActivePendingPasswordChange,
  getDashboardPasswordHash,
  getRuleById,
  isLoginLockedOut,
  listActiveLoosenRequests,
  listRules,
  recordFailedLoginAttempt,
  upsertRule,
} from "./db";
import {
  LoosenAlreadyPendingError,
  PasswordChangeAlreadyPendingError,
  applyDueLoosenRequests,
  applyDuePasswordChanges,
  requestLoosen,
  requestPasswordChange,
} from "./ratchet";
import { clearSessionCookie, createSessionCookie, hasValidSession } from "./session";
import { STATIC_RULES } from "./staticRules";
import { handleGetHostStatus } from "./hostStatus";
import { handleEventUpload, handlePostflight, handlePreflight, handleRuleDownload } from "./santaSync";
import {
  handleInstallPackage,
  handleListInstalledSoftware,
  handleListSoftwarePackages,
  handleUploadPackage,
} from "./softwareApi";
import type { Env, Policy, RuleType } from "./types";

const SYNC_ROUTES: Record<
  string,
  (machineId: string, request: Request, env: Env) => Promise<Response>
> = {
  preflight: handlePreflight,
  eventupload: handleEventUpload,
  ruledownload: handleRuleDownload,
  postflight: handlePostflight,
};

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

// Tightening only - see db.ts's upsertRule doc comment on why this
// doesn't try to detect whether an edit counts as "more restrictive".
// The caller (a human via the dashboard) is asserting that by using this
// endpoint at all rather than the loosen-request one.
async function handleCreateRule(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    device_id?: string | null;
    identifier: string;
    policy: Policy;
    rule_type: RuleType;
    custom_msg?: string;
    custom_url?: string;
    notification_app_name?: string;
  }>();

  if (body.policy === "REMOVE") {
    // REMOVE is a loosen, not a tighten - it must go through the
    // loosen-request endpoint, never created directly here. Rejecting
    // this explicitly rather than silently allowing it closes the
    // obvious way someone could bypass the ratchet entirely.
    return jsonResponse({ error: "REMOVE rules can only be created via the loosen-request endpoint" }, 400);
  }

  const id = await upsertRule(env.DB, {
    deviceId: body.device_id ?? null,
    identifier: body.identifier,
    policy: body.policy,
    ruleType: body.rule_type,
    customMsg: body.custom_msg,
    customUrl: body.custom_url,
    notificationAppName: body.notification_app_name,
  });
  return jsonResponse({ id }, 201);
}

async function handleListRules(env: Env): Promise<Response> {
  return jsonResponse(await listRules(env.DB));
}

// StaticRules from profiles/santa-config.mobileconfig - see
// staticRules.ts's doc comment. Purely for dashboard visibility; there's
// no create/edit/delete for these here, they're not stored in D1 at
// all.
function handleListStaticRules(): Response {
  return jsonResponse(STATIC_RULES);
}

async function handleListActiveLoosenRequests(env: Env): Promise<Response> {
  return jsonResponse(await listActiveLoosenRequests(env.DB));
}

// The loosen-request re-check verifies against the same dashboard
// password as login (schema.sql's dashboard_auth comment explains why
// this is deliberately one password, not two) - being logged in already
// (requireSession, checked by the caller) isn't enough on its own to
// loosen a rule, same as the Android sibling app's pattern.
async function handleLoosenRequest(ruleId: number, request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ password?: string }>();
  const storedHash = await getDashboardPasswordHash(env.DB);
  if (!body.password || !storedHash || !(await verifyPasswordHash(body.password, storedHash))) {
    return jsonResponse({ error: "incorrect or missing password" }, 403);
  }

  const rule = await getRuleById(env.DB, ruleId);
  if (!rule) {
    return jsonResponse({ error: "no such rule" }, 404);
  }

  try {
    const pending = await requestLoosen(env.DB, ruleId);
    return jsonResponse(pending, 202);
  } catch (error) {
    if (error instanceof LoosenAlreadyPendingError) {
      return jsonResponse({ error: error.message }, 409);
    }
    throw error;
  }
}

// Checks the lockout window first (db.ts's isLoginLockedOut) - a locked-
// out account never even reaches the password comparison, so brute-force
// attempts get a uniform 429 regardless of whether the guessed password
// happened to be close. A missing SESSION_SIGNING_KEY or an unbootstrapped
// password both fail closed (503), never treated as "let anyone in."
async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_SIGNING_KEY) {
    return jsonResponse({ error: "session signing key not configured" }, 503);
  }
  if (await isLoginLockedOut(env.DB)) {
    return jsonResponse({ error: "too many failed attempts - try again later" }, 429);
  }

  const body = await request.json<{ password?: string }>();
  const storedHash = await getDashboardPasswordHash(env.DB);
  if (!body.password || !storedHash || !(await verifyPasswordHash(body.password, storedHash))) {
    await recordFailedLoginAttempt(env.DB);
    return jsonResponse({ error: "incorrect password" }, 401);
  }

  await clearFailedLoginAttempts(env.DB);
  const cookie = await createSessionCookie(env.SESSION_SIGNING_KEY);
  return jsonResponse({ ok: true }, 200, { "set-cookie": cookie });
}

function handleLogout(): Response {
  return jsonResponse({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

// Requires an already-valid session (checked by the caller) *and* the
// current password, same re-check pattern as handleLoosenRequest above -
// being logged in isn't enough to change the password that logs you in.
async function handlePasswordChangeRequest(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ current_password?: string; new_password?: string }>();
  const storedHash = await getDashboardPasswordHash(env.DB);
  if (!body.current_password || !storedHash || !(await verifyPasswordHash(body.current_password, storedHash))) {
    return jsonResponse({ error: "incorrect or missing current password" }, 403);
  }
  if (!body.new_password) {
    return jsonResponse({ error: "missing new password" }, 400);
  }

  const newHash = await hashPassword(body.new_password);
  try {
    const pending = await requestPasswordChange(env.DB, newHash);
    return jsonResponse(pending, 202);
  } catch (error) {
    if (error instanceof PasswordChangeAlreadyPendingError) {
      return jsonResponse({ error: error.message }, 409);
    }
    throw error;
  }
}

async function handleGetPendingPasswordChange(env: Env): Promise<Response> {
  return jsonResponse(await getActivePendingPasswordChange(env.DB));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- Santa sync protocol (static-token-gated, see auth.ts's requireSyncToken) ---
    const syncMatch = url.pathname.match(/^\/(preflight|eventupload|ruledownload|postflight)\/([^/]+)$/);
    if (syncMatch) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const tokenError = await requireSyncToken(request, env);
      if (tokenError) return tokenError;
      const stage = syncMatch[1]!;
      const machineId = syncMatch[2]!;
      const handler = SYNC_ROUTES[stage];
      if (!handler) return new Response("Not Found", { status: 404 });
      try {
        return await handler(decodeURIComponent(machineId), request, env);
      } catch (error) {
        // Fail loudly, not silently - a malformed request or a real bug
        // here means a Mac's sync is broken, which matters. No attempt
        // to guess a "safe" fallback response; better an obvious 500
        // than Santa quietly thinking a sync succeeded when it didn't.
        console.error(`sync error on /${stage}/${machineId}:`, error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // --- Login/logout (unauthenticated by nature - these ARE the auth) ---
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout();
    }

    // --- Rule-management API (session-gated, see auth.ts's requireSession) ---
    const isRulesApiRoute =
      url.pathname === "/api/rules" ||
      url.pathname === "/api/static-rules" ||
      url.pathname === "/api/loosen-requests" ||
      url.pathname.match(/^\/api\/rules\/\d+\/loosen-request$/) ||
      url.pathname.match(/^\/api\/loosen-requests\/\d+\/cancel$/);
    if (isRulesApiRoute) {
      const authError = await requireSession(request, env);
      if (authError) return authError;

      if (url.pathname === "/api/rules" && request.method === "GET") {
        return handleListRules(env);
      }
      if (url.pathname === "/api/static-rules" && request.method === "GET") {
        return handleListStaticRules();
      }
      if (url.pathname === "/api/rules" && request.method === "POST") {
        return handleCreateRule(request, env);
      }
      if (url.pathname === "/api/loosen-requests" && request.method === "GET") {
        return handleListActiveLoosenRequests(env);
      }
      const loosenMatch = url.pathname.match(/^\/api\/rules\/(\d+)\/loosen-request$/);
      if (loosenMatch && request.method === "POST") {
        return handleLoosenRequest(Number(loosenMatch[1]), request, env);
      }
      const cancelMatch = url.pathname.match(/^\/api\/loosen-requests\/(\d+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        // No password required to cancel - only to start the loosen in
        // the first place. Changing your mind and staying restricted
        // needs no extra friction; only reducing a restriction does.
        await cancelLoosenRequest(env.DB, Number(cancelMatch[1]));
        return jsonResponse({ cancelled: true });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Software-deployment API (session-gated) ---
    const isSoftwareApiRoute =
      url.pathname === "/api/software" ||
      url.pathname === "/api/installed-software" ||
      url.pathname.match(/^\/api\/software\/\d+\/install$/);
    if (isSoftwareApiRoute) {
      const authError = await requireSession(request, env);
      if (authError) return authError;

      if (url.pathname === "/api/software" && request.method === "GET") {
        return handleListSoftwarePackages(env);
      }
      if (url.pathname === "/api/software" && request.method === "POST") {
        return handleUploadPackage(request, env);
      }
      if (url.pathname === "/api/installed-software" && request.method === "GET") {
        return handleListInstalledSoftware(request, env);
      }
      const installMatch = url.pathname.match(/^\/api\/software\/(\d+)\/install$/);
      if (installMatch && request.method === "POST") {
        return handleInstallPackage(Number(installMatch[1]), request, env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Sync health / MDM lockdown status (session-gated) ---
    if (url.pathname === "/api/host-status" && request.method === "GET") {
      const authError = await requireSession(request, env);
      if (authError) return authError;
      return handleGetHostStatus(request, env);
    }

    // --- Dashboard password-change API (session-gated) ---
    const isPasswordApiRoute =
      url.pathname === "/api/password/change-request" ||
      url.pathname === "/api/password/pending-change" ||
      url.pathname.match(/^\/api\/password\/change-request\/\d+\/cancel$/);
    if (isPasswordApiRoute) {
      const authError = await requireSession(request, env);
      if (authError) return authError;

      if (url.pathname === "/api/password/change-request" && request.method === "POST") {
        return handlePasswordChangeRequest(request, env);
      }
      if (url.pathname === "/api/password/pending-change" && request.method === "GET") {
        return handleGetPendingPasswordChange(env);
      }
      const cancelMatch = url.pathname.match(/^\/api\/password\/change-request\/(\d+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        // No password required to cancel - same reasoning as cancelling a
        // rule loosen above: staying put needs no extra friction.
        await cancelPasswordChange(env.DB, Number(cancelMatch[1]));
        return jsonResponse({ cancelled: true });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Dashboard page - renders login or the real dashboard depending
    // on session validity, never a hard 401 (dashboard.ts's own doc
    // comment explains why: index.ts decides which page based on the
    // request, not a shared gate). ---
    if (url.pathname === "/" && request.method === "GET") {
      const hasSession = env.SESSION_SIGNING_KEY ? await hasValidSession(request, env.SESSION_SIGNING_KEY) : false;
      const html = hasSession ? renderDashboard() : renderLoginPage();
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cloudflare Cron Trigger entry point - see wrangler.toml's [triggers]
  // block for the schedule. Applies every rule-loosen request AND every
  // dashboard password change whose 24h delay has elapsed (ratchet.ts).
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const appliedLoosens = await applyDueLoosenRequests(env.DB);
    if (appliedLoosens > 0) {
      console.log(`applied ${appliedLoosens} due loosen request(s)`);
    }
    const appliedPasswordChanges = await applyDuePasswordChanges(env.DB);
    if (appliedPasswordChanges > 0) {
      console.log(`applied ${appliedPasswordChanges} due password change(s)`);
    }
  },
};
