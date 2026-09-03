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

import { hashPassword, requireDaemonSyncToken, requireSession, requireSyncToken, verifyPasswordHash } from "./auth";
import { renderDashboard, renderLoginPage } from "./dashboard";
import {
  cancelLoosenRequest,
  cancelPasswordChange,
  clearFailedLoginAttempts,
  getActivePendingPasswordChange,
  getDashboardPasswordHash,
  getLoginPasswordHash,
  getRuleById,
  isLoginLockedOut,
  listActiveLoosenRequests,
  listRules,
  recordFailedLoginAttempt,
  setLoginPasswordHash,
  upsertRule,
} from "./db";
import {
  LoosenAlreadyPendingError,
  PasswordChangeAlreadyPendingError,
  applyDueLoosenRequests,
  applyDuePasswordChanges,
  applyDueProfileChanges,
  applyDueSafeAppAdditions,
  requestLoosen,
  requestPasswordChange,
} from "./ratchet";
import { clearSessionCookie, createSessionCookie, hasValidSession } from "./session";
import { KNOWN_APPLE_APPS } from "./knownApps";
import { STATIC_RULES } from "./staticRules";
import { handleGetHostStatus } from "./hostStatus";
import {
  handleCancelProfileChange,
  handleListConfigProfileDetails,
  handleListPendingProfileChanges,
  handleUpdateConfigProfile,
  handleUploadConfigProfile,
} from "./configProfilesApi";
import { handleAppInventorySync, handleSafeAppsSync } from "./daemonSync";
import { handleListAppInventory } from "./appInventoryApi";
import { handleExtensionCrx, handleExtensionUpdateManifest } from "./extensionUpdate";
import { handleEventUpload, handlePostflight, handlePreflight, handleRuleDownload } from "./santaSync";
import {
  handleCancelSafeAppAddition,
  handleListPendingSafeAppAdditions,
  handleListSafeApps,
  handleListStaticSafeApps,
  handleRemoveSafeApp,
  handleRequestAddSafeApp,
} from "./safeAppsApi";
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

// See knownApps.ts's doc comment - a hand-kept fallback list, not stored
// in D1, no create/edit/delete here either.
function handleListKnownApps(): Response {
  return jsonResponse(KNOWN_APPLE_APPS);
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
// happened to be close. A missing SESSION_SIGNING_KEY fails closed (503),
// never treated as "let anyone in."
//
// Checks against login_auth, NOT dashboard_auth - split 2026-08-25, see
// schema.sql's comment on both tables. The office password (dashboard_auth)
// is no longer involved in reaching the dashboard at all; it's only
// re-checked at the moment of an actual loosen-request.
//
// Self-bootstrapping, unlike dashboard_auth/office password: if
// login_auth has no row yet, whatever password is submitted here becomes
// the login password, and this same request logs in with it - added
// 2026-08-25, explicit user request, specifically to cover "the
// Codespace with real Cloudflare credentials isn't working" - the
// dashboard_auth pattern (manual `wrangler d1 execute` INSERT) has no
// fallback if that access is temporarily gone. Real, deliberately-
// accepted tradeoff, not unnoticed: this Worker is fully public (no
// Cloudflare Access, see failed_login_attempts' own comment), so between
// deploy and whoever gets here first, this is a genuine claim-it-first
// race, not just a bootstrap step - unlike dashboard_auth, which stays
// manual-only precisely because that gap was judged not worth reopening
// for the password that gates every loosening action. Self-closing,
// though: the moment any request succeeds here, login_auth has a row and
// this whole branch stops being reachable - the exposure window is one
// successful request, not indefinite.
async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_SIGNING_KEY) {
    return jsonResponse({ error: "session signing key not configured" }, 503);
  }
  if (await isLoginLockedOut(env.DB)) {
    return jsonResponse({ error: "too many failed attempts - try again later" }, 429);
  }

  const body = await request.json<{ password?: string }>();
  if (!body.password) {
    await recordFailedLoginAttempt(env.DB);
    return jsonResponse({ error: "incorrect password" }, 401);
  }

  const storedHash = await getLoginPasswordHash(env.DB);
  if (storedHash === null) {
    await setLoginPasswordHash(env.DB, await hashPassword(body.password));
  } else if (!(await verifyPasswordHash(body.password, storedHash))) {
    await recordFailedLoginAttempt(env.DB);
    return jsonResponse({ error: "incorrect password" }, 401);
  }

  await clearFailedLoginAttempts(env.DB);
  const cookie = await createSessionCookie(env.SESSION_SIGNING_KEY);
  return jsonResponse({ ok: true }, 200, { "set-cookie": cookie });
}

// Changes the LOGIN password (login_auth) - deliberately NOT the same
// flow as handlePasswordChangeRequest below, which changes the OFFICE
// password (dashboard_auth) and stays ratchet-gated. This one applies
// immediately once the current login password re-checks: no pending
// row, no 24h delay, no relation to ratchet.ts at all. Session-gated by
// the caller (same as every other /api/... route), plus the current-
// password re-check here - being logged in isn't enough on its own to
// change the very password that logs you in, same pattern as every
// other password-change flow in this project, just without the delay
// since changing this one doesn't loosen or tighten anything.
async function handleChangeLoginPassword(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ current_password?: string; new_password?: string }>();
  const storedHash = await getLoginPasswordHash(env.DB);
  if (!body.current_password || !storedHash || !(await verifyPasswordHash(body.current_password, storedHash))) {
    return jsonResponse({ error: "incorrect or missing current password" }, 403);
  }
  if (!body.new_password) {
    return jsonResponse({ error: "missing new password" }, 400);
  }
  const newHash = await hashPassword(body.new_password);
  await setLoginPasswordHash(env.DB, newHash);
  return jsonResponse({ ok: true });
}

function handleLogout(): Response {
  return jsonResponse({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

// Requires an already-valid session (checked by the caller) *and* the
// current password, same re-check pattern as handleLoosenRequest above.
// This changes THE OFFICE PASSWORD (dashboard_auth) - stays ratchet-
// gated (24h delay, cancellable) same as every other loosening action,
// unlike handleChangeLoginPassword above which changes a different,
// unratcheted credential. Being logged in (which no longer needs this
// password at all, see handleLogin's comment) isn't enough on its own
// to queue a change to the one that gates loosening.
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

    // --- ContentGuardDaemon's own sync (static-token-gated, see
    // auth.ts's requireDaemonSyncToken - a separate token from Santa's
    // above, two different clients) ---
    if (url.pathname === "/sync/safe-apps" && request.method === "GET") {
      const tokenError = await requireDaemonSyncToken(request, env);
      if (tokenError) return tokenError;
      return handleSafeAppsSync(env);
    }

    // The daemon's own POST counterpart to the GET above - see
    // daemonSync.ts's handleAppInventorySync doc comment. Same token,
    // opposite direction: this is the daemon PUSHING its local Team-ID
    // scan up, not pulling dashboard-approved state down.
    if (url.pathname === "/sync/app-inventory" && request.method === "POST") {
      const tokenError = await requireDaemonSyncToken(request, env);
      if (tokenError) return tokenError;
      return handleAppInventorySync(request, env);
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
      url.pathname === "/api/known-apps" ||
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
      if (url.pathname === "/api/known-apps" && request.method === "GET") {
        return handleListKnownApps();
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

    // --- Config profile detail/upload/update (session-gated) - upload
    // and update both queue through the same ratchet as Santa rule
    // loosening/the dashboard password (ratchet.ts's requestProfileChange),
    // never applying to Fleet directly - see configProfilesApi.ts's doc
    // comment. ---
    const isConfigProfileApiRoute =
      url.pathname === "/api/config-profile-details" ||
      url.pathname === "/api/config-profiles" ||
      url.pathname === "/api/pending-profile-changes" ||
      url.pathname.match(/^\/api\/config-profiles\/[^/]+$/) ||
      url.pathname.match(/^\/api\/pending-profile-changes\/\d+\/cancel$/);
    if (isConfigProfileApiRoute) {
      const authError = await requireSession(request, env);
      if (authError) return authError;

      if (url.pathname === "/api/config-profile-details" && request.method === "GET") {
        return handleListConfigProfileDetails();
      }
      if (url.pathname === "/api/config-profiles" && request.method === "POST") {
        return handleUploadConfigProfile(request, env);
      }
      if (url.pathname === "/api/pending-profile-changes" && request.method === "GET") {
        return handleListPendingProfileChanges(env);
      }
      const updateMatch = url.pathname.match(/^\/api\/config-profiles\/([^/]+)$/);
      if (updateMatch && request.method === "PATCH") {
        return handleUpdateConfigProfile(decodeURIComponent(updateMatch[1]!), request, env);
      }
      const cancelProfileChangeMatch = url.pathname.match(/^\/api\/pending-profile-changes\/(\d+)\/cancel$/);
      if (cancelProfileChangeMatch && request.method === "POST") {
        return handleCancelProfileChange(Number(cancelProfileChangeMatch[1]), env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Safe-app-bundle-ID API (session-gated) - see safeAppsApi.ts's
    // doc comment: adding queues through the same ratchet as everything
    // else (requestAddSafeApp), removing is immediate. ---
    const isSafeAppsApiRoute =
      url.pathname === "/api/safe-apps" ||
      url.pathname === "/api/static-safe-apps" ||
      url.pathname === "/api/safe-app-additions" ||
      url.pathname.match(/^\/api\/safe-apps\/[^/]+$/) ||
      url.pathname.match(/^\/api\/safe-app-additions\/\d+\/cancel$/);
    if (isSafeAppsApiRoute) {
      const authError = await requireSession(request, env);
      if (authError) return authError;

      if (url.pathname === "/api/safe-apps" && request.method === "GET") {
        return handleListSafeApps(env);
      }
      if (url.pathname === "/api/static-safe-apps" && request.method === "GET") {
        return handleListStaticSafeApps();
      }
      if (url.pathname === "/api/safe-apps" && request.method === "POST") {
        return handleRequestAddSafeApp(request, env);
      }
      if (url.pathname === "/api/safe-app-additions" && request.method === "GET") {
        return handleListPendingSafeAppAdditions(env);
      }
      const removeMatch = url.pathname.match(/^\/api\/safe-apps\/([^/]+)$/);
      if (removeMatch && request.method === "DELETE") {
        return handleRemoveSafeApp(decodeURIComponent(removeMatch[1]!), env);
      }
      const cancelAdditionMatch = url.pathname.match(/^\/api\/safe-app-additions\/(\d+)\/cancel$/);
      if (cancelAdditionMatch && request.method === "POST") {
        return handleCancelSafeAppAddition(Number(cancelAdditionMatch[1]), env);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- App-inventory API (session-gated, read-only) - see
    // appInventoryApi.ts's doc comment: the dashboard-facing view of the
    // daemon's own Team-ID scan (app_inventory), which is what actually
    // makes Installed Apps' Allow/Block buttons work for once. ---
    if (url.pathname === "/api/app-inventory" && request.method === "GET") {
      const authError = await requireSession(request, env);
      if (authError) return authError;
      return handleListAppInventory(env);
    }

    // --- Login-password change (session-gated, NOT ratchet-gated - see
    // handleChangeLoginPassword's own doc comment for why this is a
    // separate route/table from the office-password group below) ---
    if (url.pathname === "/api/login-password/change" && request.method === "POST") {
      const authError = await requireSession(request, env);
      if (authError) return authError;
      return handleChangeLoginPassword(request, env);
    }

    // --- Dashboard password-change API (session-gated) - this is the
    // OFFICE/loosen password (dashboard_auth), ratchet-gated. See the
    // login-password route just above for the other, unratcheted one. ---
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

    // --- Chrome extension self-hosted update endpoints (unauthenticated
    // by necessity - see extensionUpdate.ts's own doc comment for why) ---
    if (url.pathname === "/extension/update.xml" && request.method === "GET") {
      return handleExtensionUpdateManifest(request);
    }
    if (url.pathname === "/extension/contentguard.crx" && request.method === "GET") {
      return handleExtensionCrx(env);
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
    const appliedProfileChanges = await applyDueProfileChanges(env);
    if (appliedProfileChanges > 0) {
      console.log(`applied ${appliedProfileChanges} due profile change(s)`);
    }
    const appliedSafeAppAdditions = await applyDueSafeAppAdditions(env.DB);
    if (appliedSafeAppAdditions > 0) {
      console.log(`applied ${appliedSafeAppAdditions} due safe-app addition(s)`);
    }
  },
};
