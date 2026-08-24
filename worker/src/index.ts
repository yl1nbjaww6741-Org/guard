// ContentGuard control-panel Worker - entry point.
//
// Two distinct route groups:
//  - Santa's 4 sync-protocol stages (santaSync.ts) - called by Santa
//    itself on the Mac, not by a human, so no auth beyond the
//    machine_id/body consistency check santaSync.ts already does.
//  - The rule-management API (/api/...) - meant for the (not-yet-built)
//    dashboard, gated by `requireApiToken` as an interim stopgap until
//    Cloudflare Access is actually wired in - see auth.ts's doc comment.
//
// Fleet API integration (.pkg deployment), Cloudflare Access auth, and
// the dashboard itself are still NOT implemented - see
// mac/docs/PHASE_4_DASHBOARD_SETUP.md's status for what's real versus
// planned.

import { requireApiToken, verifyLoosenPassword } from "./auth";
import { cancelLoosenRequest, getRuleById, listRules, upsertRule } from "./db";
import { LoosenAlreadyPendingError, applyDueLoosenRequests, requestLoosen } from "./ratchet";
import { handleEventUpload, handlePostflight, handlePreflight, handleRuleDownload } from "./santaSync";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

async function handleLoosenRequest(ruleId: number, request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ password?: string }>();
  if (!body.password || !(await verifyLoosenPassword(body.password, env))) {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- Santa sync protocol ---
    const syncMatch = url.pathname.match(/^\/(preflight|eventupload|ruledownload|postflight)\/([^/]+)$/);
    if (syncMatch) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
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

    // --- Rule-management API (interim-token-gated, see auth.ts) ---
    const isRulesApiRoute =
      url.pathname === "/api/rules" ||
      url.pathname.match(/^\/api\/rules\/\d+\/loosen-request$/) ||
      url.pathname.match(/^\/api\/loosen-requests\/\d+\/cancel$/);
    if (isRulesApiRoute) {
      const authError = await requireApiToken(request, env);
      if (authError) return authError;

      if (url.pathname === "/api/rules" && request.method === "GET") {
        return handleListRules(env);
      }
      if (url.pathname === "/api/rules" && request.method === "POST") {
        return handleCreateRule(request, env);
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

    return new Response("Not Found", { status: 404 });
  },

  // Cloudflare Cron Trigger entry point - see wrangler.toml's [triggers]
  // block for the schedule. Applies every loosen request whose 24h delay
  // has elapsed since it was requested.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const appliedCount = await applyDueLoosenRequests(env.DB);
    if (appliedCount > 0) {
      console.log(`applied ${appliedCount} due loosen request(s)`);
    }
  },
};
