// Client for SimpleMDM's own REST API - built directly against
// api.simplemdm.com's real docs (fetched live, not guessed), replacing
// fleetClient.ts as part of the Fleet-to-SimpleMDM migration - see
// mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md for the full real
// comparison and endpoint-mapping table this was built against.
//
// What's CONFIRMED against real docs (trust these):
//   - Auth: HTTP Basic, API key as username, blank password
//   - POST /apps                                   - upload a .pkg
//   - GET  /devices?search=...                      - find a device
//   - POST /devices/:id/push_apps                    - install assigned apps
//   - GET  /devices/:id/installed_apps                - app inventory
//   - POST /custom_configuration_profiles/            - create a profile
//   - POST /custom_configuration_profiles/:id/devices/:device_id
//                                                      - assign to a device
//   - PATCH /custom_configuration_profiles/:id        - update in place
//
// What's NOT confirmed (documented narratively only, no live JSON
// example ever shown) - see types.ts's own comment on
// SimpleMdmDeviceAttributes/SimpleMdmProfileAttributes:
//   - GET /devices/:id            - exact attribute field names
//   - GET /devices/:id/profiles   - exact attribute field names
// getHostStatus below is written defensively (optional chaining,
// graceful fallbacks) specifically because of this - verify its output
// against one real device before trusting the dashboard's Fleet MDM
// tab blindly.
//
// Two real, structural differences from Fleet, not oversights:
//   1. No per-device, per-app targeted install exists in SimpleMDM's
//      API at all - app deployment is Assignment-Group-based. Per
//      PHASE_1C's own "one real gap" section, this project took the
//      simplify-to-push_apps option: pushApps() installs everything
//      currently assigned to the device that isn't installed yet,
//      not one specific title. At this project's single-device scale
//      that converges to the same real-world behavior as a targeted
//      install, since nothing else is ever pending.
//   2. installed_apps is a plain inventory (name/version/bundle id) -
//      it does NOT expose per-app code-signing Team ID/cdhash the way
//      Fleet's signature_information does. See getInstalledApps'
//      own doc comment - the dashboard's one-click "create a Santa
//      rule from this installed app" feature has no real SimpleMDM
//      equivalent right now.

import type {
  Env,
  MdmHostDetail,
  SimpleMdmAppAttributes,
  SimpleMdmDataEnvelope,
  SimpleMdmDeviceAttributes,
  SimpleMdmInstalledAppAttributes,
  SimpleMdmListEnvelope,
  SimpleMdmProfileAttributes,
} from "./types";

export class SimpleMdmApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(`SimpleMDM API error on ${endpoint}: ${status} ${body}`);
  }
}

const BASE_URL = "https://a.simplemdm.com/api/v1";

function requireSimpleMdmConfig(env: Env): { apiKey: string } {
  if (!env.SIMPLEMDM_API_KEY) {
    throw new Error("SIMPLEMDM_API_KEY must be set to use simpleMdmClient");
  }
  return { apiKey: env.SIMPLEMDM_API_KEY };
}

// HTTP Basic with the API key as username, blank password - confirmed
// against SimpleMDM's own docs ("It will look for your API key in the
// username field. The password field should be left blank.") - a real
// difference from Fleet's `Authorization: Bearer <token>`, not a typo.
function authHeader(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

async function simpleMdmFetch(env: Env, endpoint: string, init: RequestInit = {}): Promise<Response> {
  const { apiKey } = requireSimpleMdmConfig(env);
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: authHeader(apiKey) },
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new SimpleMdmApiError(endpoint, response.status, bodyText);
  }
  return response;
}

// Uploads a .pkg to SimpleMDM. `formData` arrives from softwareApi.ts
// shaped for Fleet's own contract (a `software` file field, per this
// project's existing dashboard upload form) - rebuilt here into
// SimpleMDM's real required shape (`binary` field, confirmed against
// their docs: "One and only one of app_store_id, bundle_id, or binary
// must be specified") rather than changing the dashboard's own upload
// contract for one vendor's field-naming choice.
export async function uploadApp(env: Env, formData: FormData): Promise<{ id: string; name: string; version?: string }> {
  const file = formData.get("software");
  if (!(file instanceof File)) {
    throw new Error("uploadApp expects a 'software' file field in formData");
  }
  const outgoing = new FormData();
  outgoing.append("binary", file, file.name);

  const endpoint = "/apps";
  const response = await simpleMdmFetch(env, endpoint, { method: "POST", body: outgoing });
  const parsed = (await response.json()) as SimpleMdmDataEnvelope<SimpleMdmAppAttributes>;
  return {
    id: String(parsed.data.id),
    name: parsed.data.attributes.name,
    version: parsed.data.attributes.version,
  };
}

// Finds a device's numeric SimpleMDM ID by a search query (name, UDID,
// serial, IMEI, MAC, or phone number - per SimpleMDM's own `search`
// param docs). Returns null on no match, same "not found is ordinary,
// not an error" contract as fleetClient.ts's findHostId.
export async function findDeviceId(env: Env, query: string): Promise<number | null> {
  const endpoint = `/devices?search=${encodeURIComponent(query)}`;
  const response = await simpleMdmFetch(env, endpoint);
  const parsed = (await response.json()) as SimpleMdmListEnvelope<SimpleMdmDeviceAttributes>;
  const first = parsed.data[0];
  return first ? Number(first.id) : null;
}

// Installs every app currently assigned to this device that isn't
// already installed - see this file's top comment for why this is the
// deliberate replacement for Fleet's per-title install, not an
// oversight. 202 Accepted, no response body, per SimpleMDM's own docs.
export async function pushApps(env: Env, deviceId: number): Promise<void> {
  await simpleMdmFetch(env, `/devices/${deviceId}/push_apps`, { method: "POST" });
}

// SimpleMDM's real app inventory for a device - a plain name/version/
// bundle-identifier list, confirmed against their docs. Does NOT carry
// the per-app code-signing Team ID/cdhash Fleet's own
// getHostSoftware/signature_information exposes, so this cannot back
// the dashboard's existing one-click "create a Santa rule from this
// installed app" feature the way Fleet's equivalent did - that
// feature has no real SimpleMDM API equivalent right now. Returned
// here as a plain inventory list anyway (still useful for display),
// with identifier/rule_type left for the caller to treat as
// permanently unavailable rather than this function fabricating one.
export async function getInstalledApps(
  env: Env,
  deviceId: number
): Promise<{ name: string; version: string | null; bundleIdentifier: string | null }[]> {
  const response = await simpleMdmFetch(env, `/devices/${deviceId}/installed_apps`);
  const parsed = (await response.json()) as SimpleMdmListEnvelope<SimpleMdmInstalledAppAttributes>;
  return parsed.data.map((item) => ({
    name: item.attributes.name,
    version: item.attributes.version ?? null,
    bundleIdentifier: item.attributes.bundle_identifier ?? item.attributes.identifier ?? null,
  }));
}

// Real connectivity + MDM-profile status for a device, shaped to match
// MdmHostDetail exactly (types.ts's alias for FleetHostDetail) so
// hostStatus.ts and the frontend need zero changes. UNCONFIRMED field
// names on SimpleMDM's side - see this file's top comment. Written
// defensively (optional chaining, graceful "unknown" fallbacks) rather
// than asserting a shape that might not match SimpleMDM's real
// response - verify against a real device once enrolled (Phase 4 of
// PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md) and correct the field
// names below if they don't match.
export async function getDeviceStatus(env: Env, deviceId: number): Promise<MdmHostDetail> {
  const deviceResponse = await simpleMdmFetch(env, `/devices/${deviceId}`);
  const device = (await deviceResponse.json()) as SimpleMdmDataEnvelope<SimpleMdmDeviceAttributes>;
  const attrs = device.data.attributes;

  const profilesResponse = await simpleMdmFetch(env, `/devices/${deviceId}/profiles`);
  const profilesParsed = (await profilesResponse.json()) as SimpleMdmListEnvelope<SimpleMdmProfileAttributes>;

  return {
    hostname: attrs.device_name ?? attrs.name ?? "unknown",
    // SimpleMDM's real status vocabulary isn't confirmed - passed
    // through as-is rather than mapped to Fleet's "online"/"offline"/
    // "missing", since guessing a mapping wrong would silently mislabel
    // the dashboard's own status pill.
    status: attrs.status ?? "unknown",
    seen_time: attrs.last_seen_at ?? "",
    os_version: attrs.os_version ?? "",
    disk_encryption_enabled: null,
    mdm: {
      enrollment_status: attrs.enrollment_channel ?? attrs.status ?? "unknown",
      connected_to_fleet: true,
      profiles: profilesParsed.data.map((p) => ({
        profile_uuid: String(p.id),
        name: p.attributes.name ?? "unknown profile",
        status: p.attributes.status ?? "unknown",
        operation_type: "install",
      })),
    },
  };
}

// Creates a new custom configuration profile, then immediately assigns
// it to the one real device this project manages
// (DEFAULT_SIMPLEMDM_DEVICE_ID) - two real SimpleMDM calls, unlike
// Fleet's single create call, since SimpleMDM separates creation from
// assignment (see PHASE_1C's own endpoint-mapping table). `formData` is
// expected to carry `profile` (the raw .mobileconfig bytes) and
// `filename` fields, same as ratchet.ts already builds for Fleet -
// translated here into SimpleMDM's real required fields (`name`,
// `mobileconfig`).
export async function createConfigurationProfile(env: Env, formData: FormData): Promise<{ profile_uuid: string }> {
  const file = formData.get("profile");
  const filename = (formData.get("filename") as string | null) ?? (file instanceof File ? file.name : "profile.mobileconfig");
  if (!(file instanceof File)) {
    throw new Error("createConfigurationProfile expects a 'profile' file field in formData");
  }

  const outgoing = new FormData();
  outgoing.append("name", filename);
  outgoing.append("mobileconfig", file, filename);

  const createEndpoint = "/custom_configuration_profiles/";
  const createResponse = await simpleMdmFetch(env, createEndpoint, { method: "POST", body: outgoing });
  const created = (await createResponse.json()) as SimpleMdmDataEnvelope<Record<string, unknown>>;
  const profileId = String(created.data.id);

  if (env.DEFAULT_SIMPLEMDM_DEVICE_ID) {
    await simpleMdmFetch(env, `/custom_configuration_profiles/${profileId}/devices/${env.DEFAULT_SIMPLEMDM_DEVICE_ID}`, {
      method: "POST",
    });
  }
  // No DEFAULT_SIMPLEMDM_DEVICE_ID set: profile is created but not
  // assigned to anything yet - fails toward "nothing pushed" rather
  // than guessing a target, same as every other fail-closed default
  // in this project.

  return { profile_uuid: profileId };
}

// Replaces an existing profile's content in place - already assigned,
// so no second assign call needed here, unlike create above.
export async function updateConfigurationProfile(
  env: Env,
  profileId: string,
  formData: FormData
): Promise<{ profile_uuid: string }> {
  const file = formData.get("profile");
  const filename = (formData.get("filename") as string | null) ?? (file instanceof File ? file.name : "profile.mobileconfig");
  if (!(file instanceof File)) {
    throw new Error("updateConfigurationProfile expects a 'profile' file field in formData");
  }

  const outgoing = new FormData();
  outgoing.append("mobileconfig", file, filename);

  const endpoint = `/custom_configuration_profiles/${profileId}`;
  await simpleMdmFetch(env, endpoint, { method: "PATCH", body: outgoing });
  return { profile_uuid: profileId };
}
