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

import type {
  Env,
  FleetAddPackageResponse,
  FleetGetHostResponse,
  FleetHostDetail,
  FleetHostSoftwareItem,
  FleetListHostSoftwareResponse,
  FleetListHostsResponse,
} from "./types";

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

// Returns everything Fleet's own osquery-based inventory already knows
// is installed on a host - built directly against fleetdm/fleet's real
// "Get host's software" docs (rest-api.md), not guessed. This is the
// software-inventory feature: rather than the dashboard user manually
// running `codesign -dv` in Terminal to find an app's Team ID (the
// Tor Browser rule's own original workflow, from Phase 3), Fleet already
// has this via its `signature_information` per installed version - this
// just surfaces it so a Santa rule can be created with one click instead.
// `macos_applications=true` scopes this to top-level /Applications
// entries only (Fleet's own param for this) - keeps the list to things a
// human would actually recognize and want to block/allow, not every
// framework/library osquery's `apps` source happens to enumerate.
export async function getHostSoftware(env: Env, hostId: number): Promise<FleetHostSoftwareItem[]> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = `/api/v1/fleet/hosts/${hostId}/software?macos_applications=true&per_page=200`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
  const parsed = JSON.parse(bodyText) as FleetListHostSoftwareResponse;
  return parsed.software ?? [];
}

// Real connectivity + MDM-lockdown status for a host - built directly
// against fleetdm/fleet's real "Get host" docs (rest-api.md), not
// guessed. Backs the dashboard's "Sync health" and "MDM lockdown"
// sections: whether Fleet has heard from this Mac recently
// (status/seen_time) and what MDM actually has locked down right now
// (disk_encryption_enabled, mdm.enrollment_status, and the real
// per-profile verified/pending/failed status Fleet tracks) - not what
// this repo's profiles/ directory *intends* to enforce, what Fleet has
// actually confirmed applied.
// `exclude_software=true` since the installed-software list is already
// covered by getHostSoftware above - no reason to double the payload
// size fetching it again here.
export async function getHostStatus(env: Env, hostId: number): Promise<FleetHostDetail> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = `/api/v1/fleet/hosts/${hostId}?exclude_software=true`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
  const parsed = JSON.parse(bodyText) as FleetGetHostResponse;
  const h = parsed.host;
  return {
    hostname: h.hostname,
    status: h.status,
    seen_time: h.seen_time,
    os_version: h.os_version,
    disk_encryption_enabled: h.disk_encryption_enabled ?? null,
    mdm: h.mdm
      ? {
          enrollment_status: h.mdm.enrollment_status,
          connected_to_fleet: h.mdm.connected_to_fleet,
          profiles: h.mdm.profiles ?? [],
        }
      : null,
  };
}

// Uploads a brand-new configuration profile to Fleet - built directly
// against fleetdm/fleet's real "Create configuration profile" docs
// (rest-api.md, POST /api/v1/fleet/configuration_profiles, Fleet
// Premium - already purchased in Phase 1). `formData` is expected to
// already contain a `profile` file field (the raw .mobileconfig bytes)
// - same "thin, faithful proxy" pattern as uploadPackage above, this
// function doesn't construct the FormData itself. Fleet 409s on a
// duplicate PayloadDisplayName/PayloadIdentifier - surfaced to the
// caller as a FleetApiError, not swallowed, since that's the real
// signal to use the update endpoint below instead.
export async function createConfigurationProfile(env: Env, formData: FormData): Promise<{ profile_uuid: string }> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = "/api/v1/fleet/configuration_profiles";
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
  return JSON.parse(bodyText) as { profile_uuid: string };
}

// Replaces an existing configuration profile's content in place - built
// directly against fleetdm/fleet's real "Update configuration profile"
// docs (PATCH /api/v1/fleet/configuration_profiles/:profile_uuid, also
// Fleet Premium). Fleet itself enforces the real safety property here,
// not this Worker: per Fleet's own docs, the replacement file's
// PayloadIdentifier must match the existing profile's, or the request
// is rejected - this Worker deliberately doesn't pre-parse the uploaded
// file's plist content to duplicate that check (no plist-parsing
// dependency in this project, same reasoning as everywhere else), it
// just passes the file through and lets Fleet's own validation be the
// real gate.
export async function updateConfigurationProfile(
  env: Env,
  profileUuid: string,
  formData: FormData
): Promise<{ profile_uuid: string }> {
  const { baseUrl, token } = requireFleetConfig(env);
  const endpoint = `/api/v1/fleet/configuration_profiles/${profileUuid}`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new FleetApiError(endpoint, response.status, bodyText);
  }
  return JSON.parse(bodyText) as { profile_uuid: string };
}
