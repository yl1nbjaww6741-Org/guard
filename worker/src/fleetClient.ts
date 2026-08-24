// Client for Fleet's own REST API - built directly against
// fleetdm/fleet's docs/REST API/rest-api.md (fetched from the real repo
// at github.com/fleetdm/fleet, not guessed or reconstructed from
// secondhand summaries, same discipline as santaSync.ts's protocol
// implementation). This is the same API Fleet's own web UI uses - see
// mac/README.md's Phase 4 row for why that matters (the "single control
// panel" scope decision).
//
// Three endpoints only, the minimum this project's ".pkg deployment from
// the dashboard" scope needs:
//   POST /api/v1/fleet/software/package               - upload a package
//   GET  /api/v1/fleet/hosts?query=...                 - find a host by
//                                                         hostname/serial
//   POST /api/v1/fleet/hosts/:id/software/:title_id/install
//                                                       - trigger install
//
// Auth: standard bearer token (`Authorization: Bearer <token>`), tied to
// a Fleet user account, retrieved from Fleet's own UI ("My account" ->
// "Get API token") - not something this Worker can generate itself, has
// to be a real value from the real Fleet instance, same as every other
// real-value secret in this project.

import type { Env, FleetAddPackageResponse, FleetListHostsResponse } from "./types";

export class FleetApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Fleet API error on ${endpoint}: ${status} ${body}`);
  }
}

function requireFleetConfig(env: Env): { baseUrl: string; token: string } {
  if (!env.FLEET_BASE_URL || !env.FLEET_API_TOKEN) {
    throw new Error("FLEET_BASE_URL and FLEET_API_TOKEN must both be set to use fleetClient");
  }
  return { baseUrl: env.FLEET_BASE_URL.replace(/\/$/, ""), token: env.FLEET_API_TOKEN };
}

// Uploads a package to Fleet. `formData` is expected to already contain
// the fields Fleet's "Add package" endpoint documents - at minimum a
// `software` file field. This function doesn't construct the FormData
// itself (index.ts's route handler does, from the incoming request) -
// keeping this a thin, faithful proxy to Fleet's own API rather than a
// place that silently reinterprets what the caller asked for.
export async function uploadPackage(env: Env, formData: FormData): Promise<FleetAddPackageResponse> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = "/api/v1/fleet/software/package";
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    // No content-type header set deliberately - fetch sets the correct
    // multipart/form-data boundary itself from the FormData body. Fleet's
    // docs are explicit this endpoint requires multipart/form-data (see
    // this file's top comment).
    body: formData,
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
  return JSON.parse(bodyText) as FleetAddPackageResponse;
}

// Finds a host's numeric Fleet ID by a search query (hostname, serial,
// UUID, or IP - per Fleet's own "List hosts" `query` parameter). Returns
// null if no host matches, rather than throwing - "not found" is an
// expected, ordinary outcome here, not an error condition.
export async function findHostId(env: Env, query: string): Promise<number | null> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = `/api/v1/fleet/hosts?query=${encodeURIComponent(query)}`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
  const parsed = JSON.parse(bodyText) as FleetListHostsResponse;
  return parsed.hosts[0]?.id ?? null;
}

// Triggers an install of an already-uploaded package on a specific host.
// Fleet's own docs: "Status: 202" with no response body on success - this
// is fire-and-forget from the caller's perspective; Fleet performs the
// actual install asynchronously. Checking install status/results is not
// implemented yet (Fleet's own "Get software install result" endpoint,
// GET /api/v1/fleet/software/install/:install_uuid/results, would need
// wiring up separately - not needed for a first working slice).
export async function installOnHost(env: Env, hostId: number, softwareTitleId: number): Promise<void> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = `/api/v1/fleet/hosts/${hostId}/software/${softwareTitleId}/install`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
}
