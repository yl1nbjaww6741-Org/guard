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
// GET /devices/:id and GET /devices/:id/profiles - confirmed for real
// against a live device (2026-08-26, this Mac, device id 2381595) after
// initially being reasoned guesses. Two real findings from that live
// check, not further guessing:
//   - Device attributes use `filevault_enabled` (a real boolean) and
//     `status` (an enrollment-state word like "enrolled" - NOT a
//     Fleet-style "online"/"offline"/connectivity word). getDeviceStatus
//     below reflects both.
//   - Profile attributes have NO status field of any kind - just name,
//     profile_identifier, group_count, device_count. This isn't a wrong
//     field-name guess to fix, it's a genuine, permanent capability gap:
//     SimpleMDM's profiles endpoint confirms a profile is *assigned*
//     (group_count/device_count), not that it's been *verified
//     installed* the way Fleet's own per-profile verified/pending/failed
//     status was. Nothing to parse here that isn't already being parsed
//     - see getDeviceStatus's own comment on what this means for the
//     dashboard's MDM lockdown display.
//
// Also real, confirmed the same day: GET /devices/:id's response
// includes `recovery_lock_password` directly - Recovery Lock genuinely
// CAN be read back, not just rotated/cleared (resolves that open
// question from PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md). Not wired
// into this client - the dashboard has no Recovery-Lock-display surface
// today, and this value is sensitive enough that adding one deserves
// its own deliberate pass, not a drive-by addition here.
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

// SimpleMDM's list endpoints are cursor-paginated - confirmed against
// their own docs: `limit` (1-100, DEFAULTS TO 10 if omitted),
// `starting_after` (an object id, not an opaque cursor token), and a
// `has_more` boolean on the response. Real bug found live (2026-08-27):
// getInstalledApps originally fetched only the first page with no
// `limit` set at all - meaning the real default of 10 - so on a device
// with 100+ installed apps (every built-in macOS app alone clears
// that), anything past the 10th silently never got fetched, including
// whatever was installed most recently. This helper fetches every page
// (explicit limit=100 per request, following `starting_after` from the
// last item's real id until has_more is false) so every list-backed
// client function is correct regardless of how many items exist, not
// just correct today because the current count happens to fit on one
// page.
async function fetchAllPages<T>(env: Env, endpoint: string): Promise<Array<{ id: number | string; attributes: T }>> {
  const separator = endpoint.includes("?") ? "&" : "?";
  const results: Array<{ id: number | string; attributes: T }> = [];
  let startingAfter: string | number | null = null;
  for (;;) {
    const cursor = startingAfter !== null ? `&starting_after=${encodeURIComponent(String(startingAfter))}` : "";
    const response = await simpleMdmFetch(env, `${endpoint}${separator}limit=100${cursor}`);
    const parsed = (await response.json()) as SimpleMdmListEnvelope<T>;
    results.push(...parsed.data);
    if (!parsed.has_more || parsed.data.length === 0) break;
    startingAfter = parsed.data[parsed.data.length - 1]!.id;
  }
  return results;
}

// Manually builds a multipart/form-data body as a stream instead of
// buffering the whole file into a Blob/FormData first - a single
// `outgoing.append("binary", file)` (the original shape of this
// function, see git history) reads fine for a small file, but a real
// .pkg upload found live (2026-09-04) that was well over 100MB
// exposed two separate real ceilings that buffering would hit even if
// Cloudflare's edge let the request through at all:
//   1. Cloudflare Workers' incoming-request body limit - confirmed via
//      Cloudflare's own docs: 100MB on Free/Pro, 200MB Business, 500MB
//      Enterprise. This is enforced at the edge, before this Worker's
//      own code ever runs, on the *inbound* dashboard->Worker request -
//      which is exactly why softwareApi.ts no longer sends the whole
//      file in one request at all (see its own top comment: the
//      dashboard now uploads in R2-multipart chunks instead). This
//      function only ever sees the file after it's already sitting in
//      R2, so that limit doesn't apply here.
//   2. A Worker instance's own memory ceiling (~128MB) - confirmed via
//      Cloudflare's own docs, separate from the request-size limit
//      above and NOT bypassed by fixing (1). Reading the whole file
//      into one ArrayBuffer/Blob (what `new FormData().append(name,
//      blob)` requires) to hand to SimpleMDM would still blow past
//      this for anything approaching that size, even once the file's
//      already safely in R2. Streaming the multipart body - reading
//      the R2 object's own ReadableStream and piping it straight into
//      this outgoing fetch's body - never holds more than one chunk in
//      memory at a time, so it's correct regardless of file size.
function buildStreamingMultipartBody(
  fieldName: string,
  filename: string,
  fileStream: ReadableStream<Uint8Array>,
  fileSize: number
): { body: ReadableStream<Uint8Array>; contentType: string; contentLength: number } {
  const boundary = `----ContentGuardBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  // Escaping isn't needed for filename here - it's always the sanitized
  // key softwareUpload.ts already generated, never raw user input.
  const preamble = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

  // A `pull`-based source, not an eager start()-only loop that drains
  // fileStream as fast as it can be read - real bug found live
  // (2026-09-04): the first version of this function did exactly that
  // (one big `for` loop inside `start()`, enqueuing every chunk with no
  // backpressure check at all). R2's own read speed is far faster than
  // the outbound upload to SimpleMDM's API can drain the outgoing
  // stream, so for a real ~150-200MB .pkg that raced ahead and buffered
  // nearly the whole object into this stream's internal queue before
  // the network ever caught up - blowing well past a Worker isolate's
  // ~128MB memory ceiling (confirmed against Cloudflare's own docs).
  // Surfaced as Cloudflare's own edge error page, verbatim "Worker
  // exceeded resource limits" (error 1102) - not this project's own
  // code, since the isolate was killed before handleUploadComplete's
  // own error handling ever ran. `pull()` fixes this by construction:
  // the runtime only calls it again once the consumer has actually
  // drained enough of the stream's internal queue to want more, so
  // production is paced to match transmission speed instead of racing
  // ahead of it - this is the whole reason streaming multipart bodies
  // exist in the first place (see this function's own top comment for
  // the two real ceilings it was meant to dodge; eager start()-only
  // reading silently reintroduced the second one).
  let phase: "preamble" | "body" | "epilogue" | "done" = "preamble";
  const reader = fileStream.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === "preamble") {
        controller.enqueue(preamble);
        phase = "body";
        return;
      }
      if (phase === "body") {
        const { done, value } = await reader.read();
        if (done) {
          phase = "epilogue";
          return;
        }
        controller.enqueue(value);
        return;
      }
      if (phase === "epilogue") {
        controller.enqueue(epilogue);
        phase = "done";
        controller.close();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
    },
  });

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: preamble.byteLength + fileSize + epilogue.byteLength,
  };
}

// Uploads a .pkg to SimpleMDM from an R2 object's own stream, rather
// than from a FormData already sitting in Worker memory - see
// buildStreamingMultipartBody's doc comment above for why. Called by
// softwareApi.ts's handleUploadComplete once softwareUpload.ts's
// R2-multipart flow has finished reassembling the file server-side.
export async function uploadAppFromStream(
  env: Env,
  fileStream: ReadableStream<Uint8Array>,
  fileSize: number,
  filename: string
): Promise<{ id: string; name: string; version?: string }> {
  const { apiKey } = requireSimpleMdmConfig(env);
  const { body, contentType, contentLength } = buildStreamingMultipartBody("binary", filename, fileStream, fileSize);

  const endpoint = "/apps";
  // Streaming request bodies need `duplex: "half"` per the fetch spec's
  // half-duplex streaming-body requirement - not yet in the TS DOM lib's
  // RequestInit type workerd otherwise matches, hence the cast.
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    },
    body,
    duplex: "half",
  } as RequestInit);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new SimpleMdmApiError(endpoint, response.status, bodyText);
  }
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
  // Full pagination, not just the first page - see fetchAllPages' own
  // doc comment for the real bug this fixes (a device with 100+
  // installed apps was silently truncated to the first 10, the
  // unstated default, missing anything installed most recently).
  const items = await fetchAllPages<SimpleMdmInstalledAppAttributes>(env, `/devices/${deviceId}/installed_apps`);
  return items.map((item) => ({
    name: item.attributes.name,
    version: item.attributes.version ?? null,
    bundleIdentifier: item.attributes.bundle_identifier ?? item.attributes.identifier ?? null,
  }));
}

// Real connectivity + MDM-profile status for a device, shaped to match
// MdmHostDetail exactly (types.ts's alias for FleetHostDetail) so
// hostStatus.ts and the frontend need zero changes. Field names below
// are CONFIRMED against a real device response (2026-08-26) - see this
// file's top comment for the two real findings that came out of that
// check.
export async function getDeviceStatus(env: Env, deviceId: number): Promise<MdmHostDetail> {
  const deviceResponse = await simpleMdmFetch(env, `/devices/${deviceId}`);
  const device = (await deviceResponse.json()) as SimpleMdmDataEnvelope<SimpleMdmDeviceAttributes>;
  const attrs = device.data.attributes;

  // Full pagination too - this Mac only has 8 profiles today (comfortably
  // under the real default page size of 10), so this specific call
  // wasn't yet showing the same symptom getInstalledApps was, but it's
  // the identical latent bug and would break the moment a 9th profile
  // gets added - fixed proactively rather than waiting for it to bite.
  const profiles = await fetchAllPages<SimpleMdmProfileAttributes>(env, `/devices/${deviceId}/profiles`);

  return {
    hostname: attrs.device_name ?? attrs.name ?? "unknown",
    // Confirmed real value: an enrollment-state word ("enrolled"), not
    // a Fleet-style "online"/"offline"/connectivity word - SimpleMDM's
    // device-detail endpoint doesn't expose a live connectivity signal
    // at all, only last_seen_at. dashboard.ts's own rendering has been
    // updated to derive its status-dot color from seen_time's recency
    // instead of comparing this field to "online" (which would always
    // be false for a SimpleMDM-sourced value and show red regardless
    // of real health).
    status: attrs.status ?? "unknown",
    seen_time: attrs.last_seen_at ?? "",
    os_version: attrs.os_version ?? "",
    // Confirmed real field (filevault_enabled) - was hardcoded null
    // before this was verified against a live response.
    disk_encryption_enabled: attrs.filevault_enabled ?? null,
    mdm: {
      enrollment_status: attrs.status ?? "unknown",
      // No live per-request connectivity check exists to base this on
      // (see the status field's own comment above) - true here just
      // means "the API call for this device succeeded," not a real
      // heartbeat signal the way Fleet's connected_to_fleet was.
      connected_to_fleet: true,
      profiles: profiles.map((p) => ({
        profile_uuid: String(p.id),
        name: p.attributes.name ?? "unknown profile",
        // Confirmed real finding: SimpleMDM's profiles endpoint has no
        // status field at all - see this file's top comment. "assigned"
        // reflects what's actually confirmed (group_count/device_count
        // show it's associated with this device, via its group), not a
        // fabricated verified/pending/failed value this data can't
        // support.
        status: "assigned",
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
