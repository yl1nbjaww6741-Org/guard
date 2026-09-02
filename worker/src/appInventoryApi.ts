// Route handler for the dashboard's read-only view of app_inventory
// (/api/app-inventory) - the daemon-reported Team-ID data that makes a
// real, working Allow/Block button possible per app, unlike
// handleListInstalledSoftware's always-null identifier/rule_type (see
// migrations/0008_app_inventory.sql's own comment for the full "why").
//
// Read-only on purpose: this table is never edited from the dashboard
// itself, only ever replaced wholesale by the daemon's own next sync
// (daemonSync.ts's handleAppInventorySync) - there's nothing here to
// add/remove/cancel the way safe-apps or rules have. The dashboard's
// actual actions (Allow/Block) go through the existing /api/rules
// endpoint (handleCreateRule), same as Installed Apps' buttons already
// do - this file only supplies the Team ID those buttons need to send.

import { listAppInventory } from "./db";
import type { Env } from "./types";

export async function handleListAppInventory(env: Env): Promise<Response> {
  const apps = await listAppInventory(env.DB);
  return new Response(JSON.stringify(apps), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
