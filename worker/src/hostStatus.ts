// Backs the dashboard's "Sync health" and "MDM lockdown" sections - see
// db.ts's listDevices and simpleMdmClient.ts's getDeviceStatus doc
// comments for why these are two genuinely separate signals, not
// duplicates of each other. This file just combines them into one
// response so the dashboard can render both sections from a single
// fetch.
//
// Migrated off fleetClient.ts to simpleMdmClient.ts (see
// mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md) - the response's
// own field name (`fleet`) is kept as-is rather than renamed, since the
// frontend (web/src/lib/useMdm.ts and its callers) reads that exact
// field name regardless of which MDM vendor populates it. See
// types.ts's MdmHostDetail alias comment for the same reasoning.

import { findDeviceId, getDeviceStatus } from "./simpleMdmClient";
import { listDevices } from "./db";
import type { DeviceRecord } from "./db";
import type { Env, MdmHostDetail } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface HostStatusResponse {
  devices: DeviceRecord[];
  // null when SimpleMDM isn't configured (SIMPLEMDM_API_KEY unset) or
  // the configured device can't be found - the dashboard shows this as
  // its own "not available" state rather than failing the whole
  // section, since Santa sync health (devices above) is still real and
  // worth showing even if the MDM side is unreachable.
  fleet: MdmHostDetail | null;
  fleetError: string | null;
}

// Same host-resolution rule as the other MDM-backed routes: an explicit
// `host` query param, or DEFAULT_SIMPLEMDM_DEVICE_ID (this project's one
// real Mac) as the fallback - see softwareApi.ts's
// handleListInstalledSoftware for the same pattern.
export async function handleGetHostStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = url.searchParams.get("host") || env.DEFAULT_SIMPLEMDM_DEVICE_ID;

  const devices = await listDevices(env.DB);

  let fleet: MdmHostDetail | null = null;
  let fleetError: string | null = null;
  if (!host) {
    fleetError = "no device configured (DEFAULT_SIMPLEMDM_DEVICE_ID unset, no explicit host given)";
  } else {
    try {
      // DEFAULT_SIMPLEMDM_DEVICE_ID is already a numeric SimpleMDM
      // device id - only a caller-supplied `host` (name/serial/etc.)
      // needs resolving via findDeviceId's search.
      const deviceId = url.searchParams.get("host") ? await findDeviceId(env, host) : Number(host);
      if (deviceId === null || Number.isNaN(deviceId)) {
        fleetError = `no SimpleMDM device found matching '${host}'`;
      } else {
        fleet = await getDeviceStatus(env, deviceId);
      }
    } catch (error) {
      // SimpleMDM being unreachable/misconfigured shouldn't hide
      // Santa's own sync health, which is why this catches here rather
      // than letting the whole route throw - same reasoning as the
      // fleetError field's own doc comment above.
      fleetError = error instanceof Error ? error.message : String(error);
    }
  }

  const response: HostStatusResponse = { devices, fleet, fleetError };
  return jsonResponse(response);
}
