// Backs the dashboard's "Sync health" and "MDM lockdown" sections - see
// db.ts's listDevices and fleetClient.ts's getHostStatus doc comments
// for why these are two genuinely separate signals, not duplicates of
// each other. This file just combines them into one response so the
// dashboard can render both sections from a single fetch.

import { findHostId, getHostStatus } from "./fleetClient";
import { listDevices } from "./db";
import type { DeviceRecord } from "./db";
import type { Env, FleetHostDetail } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface HostStatusResponse {
  devices: DeviceRecord[];
  // null when Fleet isn't configured (FLEET_BASE_URL/FLEET_API_TOKEN
  // unset) or the configured host can't be found - the dashboard shows
  // this as its own "Fleet not available" state rather than failing the
  // whole section, since Santa sync health (devices above) is still
  // real and worth showing even if Fleet itself is unreachable.
  fleet: FleetHostDetail | null;
  fleetError: string | null;
}

// Same host-resolution rule as the other Fleet-backed routes: an
// explicit `host` query param, or DEFAULT_FLEET_HOST (this project's one
// real Mac) as the fallback - see softwareApi.ts's
// handleListInstalledSoftware for the same pattern.
export async function handleGetHostStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || env.DEFAULT_FLEET_HOST;

  const devices = await listDevices(env.DB);

  let fleet: FleetHostDetail | null = null;
  let fleetError: string | null = null;
  if (!host) {
    fleetError = "no host configured (DEFAULT_FLEET_HOST unset, no explicit host given)";
  } else {
    try {
      const hostId = await findHostId(env, host);
      if (hostId === null) {
        fleetError = `no Fleet host found matching '${host}'`;
      } else {
        fleet = await getHostStatus(env, hostId);
      }
    } catch (error) {
      // Fleet being unreachable/misconfigured shouldn't hide Santa's own
      // sync health, which is why this catches here rather than letting
      // the whole route throw - same reasoning as the fleetError field's
      // own doc comment above.
      fleetError = error instanceof Error ? error.message : String(error);
    }
  }

  const response: HostStatusResponse = { devices, fleet, fleetError };
  return jsonResponse(response);
}
