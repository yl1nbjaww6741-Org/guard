// ContentGuard control-panel Worker - entry point.
//
// Routes Santa's 4 sync-protocol stages (see santaSync.ts for the real
// northpolesec/protos sync/v1.proto this was built against). Fleet API
// integration (.pkg deployment), the ratchet/loosen-request mechanism,
// Cloudflare Access auth, and the dashboard itself are NOT implemented
// yet - see mac/docs/PHASE_4_DASHBOARD_SETUP.md's status for what's real
// versus planned. This file only wires up what santaSync.ts already does.

import { handleEventUpload, handlePostflight, handlePreflight, handleRuleDownload } from "./santaSync";
import type { Env } from "./types";

const SYNC_ROUTES: Record<
  string,
  (machineId: string, request: Request, env: Env) => Promise<Response>
> = {
  preflight: handlePreflight,
  eventupload: handleEventUpload,
  ruledownload: handleRuleDownload,
  postflight: handlePostflight,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    // Matches the proto's URL pattern: /{stage}/{machine_id}
    const match = url.pathname.match(/^\/(preflight|eventupload|ruledownload|postflight)\/([^/]+)$/);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    // Both capture groups are guaranteed present by the regex matching at
    // all (it has exactly two capturing groups, neither optional) -
    // non-null here reflects that guarantee, not an assumption TypeScript
    // can otherwise verify on its own.
    const stage = match[1]!;
    const machineId = match[2]!;
    const handler = SYNC_ROUTES[stage];
    if (!handler) {
      return new Response("Not Found", { status: 404 });
    }
    try {
      return await handler(decodeURIComponent(machineId), request, env);
    } catch (error) {
      // Fail loudly, not silently - a malformed request or a real bug
      // here means a Mac's sync is broken, which matters. No attempt to
      // guess a "safe" fallback response; better an obvious 500 than
      // Santa quietly thinking a sync succeeded when it didn't.
      console.error(`sync error on /${stage}/${machineId}:`, error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
