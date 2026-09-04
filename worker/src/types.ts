// Types for Santa's sync protocol, built directly against
// northpolesec/protos' sync/v1.proto (cloned and read for real from
// github.com/northpolesec/protos, not guessed or reconstructed from
// secondhand docs - see this repo's mac/docs/PHASE_4_DASHBOARD_SETUP.md
// for why that mattered this time). Field names below match each
// message's `json_name` annotation exactly, since Santa's default sync
// transport is JSON over HTTP (protobuf's standard proto3 JSON mapping,
// confirmed via northpole.dev/features/sync/ - binary protobuf transfer
// is opt-in via `SyncEnableProtoTransfer`, not the default, and this
// Worker doesn't implement that opt-in path).
//
// Enum fields are typed as their proto3 JSON string names (e.g.
// "MONITOR", not the integer 1) - that's proto3's default JSON mapping
// for enums, and deliberately NOT the same encoding
// profiles/santa-config.mobileconfig uses for the same concept
// (ClientMode as a plist <integer>) - that's a different format
// (Apple's .mobileconfig for Santa's *static* configuration profile),
// unrelated to this sync protocol's JSON wire format.

export type ClientMode = "MONITOR" | "LOCKDOWN" | "STANDALONE";

export type Policy =
  | "ALLOWLIST"
  | "ALLOWLIST_COMPILER"
  | "BLOCKLIST"
  | "SILENT_BLOCKLIST"
  | "REMOVE"
  | "CEL"
  | "SILENT_GUI_BLOCKLIST"
  | "SILENT_TTY_BLOCKLIST";

export type RuleType = "BINARY" | "CERTIFICATE" | "TEAMID" | "SIGNINGID" | "CDHASH";

export type SyncType =
  | "NORMAL"
  | "CLEAN"
  | "CLEAN_ALL"
  | "CLEAN_STANDALONE"
  | "CLEAN_RULES"
  | "CLEAN_FILE_ACCESS_RULES";

export interface Rule {
  identifier: string;
  policy: Policy;
  rule_type: RuleType;
  custom_msg?: string;
  custom_url?: string;
  notification_app_name?: string;
}

// PreflightRequest - only the fields this Worker actually reads are kept
// required; everything else Santa sends is accepted but unused for now
// (see mac/docs/PHASE_4_DASHBOARD_SETUP.md's "not built yet" list).
export interface PreflightRequest {
  serial_num?: string;
  hostname?: string;
  os_version?: string;
  os_build?: string;
  model_identifier?: string;
  santa_version?: string;
  primary_user?: string;
  client_mode?: ClientMode;
  request_clean_sync?: boolean;
  machine_id: string;
}

export interface PreflightResponse {
  client_mode: ClientMode;
  batch_size?: number;
}

export interface EventEntry {
  file_sha256?: string;
  file_path?: string;
  file_name?: string;
  team_id?: string;
  decision: string;
  execution_time: number;
}

export interface EventUploadRequest {
  events?: EventEntry[];
  machine_id: string;
}

export interface EventUploadResponse {
  event_upload_bundle_binaries?: string[];
}

export interface RuleDownloadRequest {
  cursor?: string;
  machine_id: string;
}

export interface RuleDownloadResponse {
  rules: Rule[];
  cursor?: string;
}

export interface PostflightRequest {
  rules_received?: number;
  rules_processed?: number;
  machine_id: string;
  sync_type?: SyncType;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type PostflightResponse = Record<string, never>;

export interface Env {
  DB: D1Database;
  // Hosts the self-packaged Chrome extension (.crx) for MDM force-install
  // - see extensionUpdate.ts's own doc comment and
  // chrome-extension/build/README.md for the full flow. The .crx is
  // ~90MB, well past anything sensible to bundle into the Worker script
  // itself, hence R2 rather than a KV/vars value. Optional (`?`) since a
  // fresh deploy before the bucket's been created/populated should still
  // start up - handleExtensionCrx's own 404 path covers "not uploaded
  // yet" explicitly rather than this Worker crashing on an unbound
  // reference.
  EXTENSION_ASSETS?: R2Bucket;
  // Static shared token Santa sends via SyncExtraHeaders (see
  // auth.ts's requireSyncToken doc comment) - protects the sync
  // endpoints, which are otherwise reachable by anyone on the internet.
  SANTA_SYNC_TOKEN?: string;
  // Static shared token ContentGuardDaemon itself sends (see
  // auth.ts's requireDaemonSyncToken) to fetch the current safe-app-
  // bundle-ID list from GET /sync/safe-apps (daemonSync.ts). Deliberately
  // separate from SANTA_SYNC_TOKEN - two different sync clients, no
  // reason to share a credential.
  CONTENTGUARD_DAEMON_SYNC_TOKEN?: string;
  // Static shared token the Chrome extension's background service worker
  // sends (see auth.ts's requireExtensionSyncToken) to fetch the current
  // blocked-keywords list from GET /sync/keywords (extensionSync.ts).
  // Same reasoning as CONTENTGUARD_DAEMON_SYNC_TOKEN being separate from
  // SANTA_SYNC_TOKEN - a third, independent sync client (the extension
  // isn't the daemon and isn't Santa), no reason to share a credential
  // with either. A browser extension is also a meaningfully weaker place
  // to hold a secret than a codesigned Mac binary (its unpacked source is
  // inspectable by anyone with the .crx/repo) - this token only guards
  // read access to the keyword list, never anything that can widen what
  // the extension is allowed to do server-side, so that exposure is
  // accepted, not a hidden gap. Re-added 2026-09-04 - was deleted along
  // with the rest of the keyword-blocking subsystem in 30a332e; needs a
  // fresh `wrangler secret put CONTENTGUARD_EXTENSION_SYNC_TOKEN` on the
  // real deployment (the old value was never rotated back in, so this
  // has to be provisioned again, not just left as-is).
  CONTENTGUARD_EXTENSION_SYNC_TOKEN?: string;
  // Signs/verifies dashboard session cookies (session.ts) - internal
  // cryptographic key, not user-facing, so it stays a static Wrangler
  // secret rather than going through the password ratchet the way the
  // dashboard password itself does (see schema.sql's dashboard_auth
  // comment for why that one lives in D1 instead).
  SESSION_SIGNING_KEY?: string;
  // SimpleMDM API credentials - see simpleMdmClient.ts's doc comment for
  // the real API reference this was built against. Auth is HTTP Basic
  // with the API key as the username and a blank password (Fleet, which
  // this replaced per mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md,
  // used a bearer token instead - see simpleMdmClient.ts's
  // requireSimpleMdmConfig).
  SIMPLEMDM_API_KEY?: string;
  // SimpleMDM's own numeric device ID to fall back to when no explicit
  // `host` is given - this project only ever has one real Mac in scope,
  // so requiring that identifier to be typed in every single time is
  // pure friction, not a real safeguard. Not a secret - safe as a plain
  // wrangler.toml [vars] entry.
  DEFAULT_SIMPLEMDM_DEVICE_ID?: string;
}

// --- MDM host/profile status shapes ---
// Named neutrally (not after a specific vendor) since this project has
// switched MDM providers once already (Fleet -> SimpleMDM, see
// mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md) and the frontend
// (web/src/lib/useMdm.ts, Home.tsx, Fleet.tsx, ChromePolicy.tsx) only
// ever depends on these field names - status, seen_time,
// mdm.profiles[].profile_uuid/name/status - never on which vendor
// populated them. `profile_uuid` holds whatever identifier the current
// MDM vendor uses for a profile (a SimpleMDM numeric id, stringified,
// today) - the name is a holdover from when Fleet's real UUIDs lived
// here, kept rather than renamed again for a field nothing outside this
// type actually parses as a UUID.

export interface MdmProfileInfo {
  profile_uuid: string;
  name: string;
  status: string;
  operation_type: string;
}

export interface MdmInfo {
  enrollment_status: string;
  connected_to_fleet: boolean;
  profiles: MdmProfileInfo[];
}

export interface MdmHostDetail {
  hostname: string;
  status: string;
  seen_time: string;
  os_version: string;
  disk_encryption_enabled: boolean | null;
  mdm: MdmInfo | null; // null on a host that isn't MDM-enrolled at all
}

// --- SimpleMDM's own REST API shapes (the subset this Worker uses) ---
// Built directly against api.simplemdm.com's own docs - see
// simpleMdmClient.ts's top comment for the full real/unconfirmed
// breakdown. SimpleMDM wraps every resource in a JSON:API-style
// envelope - confirmed via real examples in their docs (a
// custom_attribute_value example, an assignment_group example) for the
// general {data: {type, id, attributes}} shape - but the EXACT
// attribute names for a device's own detail/profiles responses were
// only ever described narratively in their docs, never shown as a live
// example anywhere. SimpleMdmDeviceAttributes/SimpleMdmProfileAttributes
// below are a reasoned best guess at the real field names, not a
// guarantee - verify against one real device before trusting
// getHostStatus's output.

export interface SimpleMdmDataEnvelope<T> {
  data: { type: string; id: number | string; attributes: T };
}

export interface SimpleMdmListEnvelope<T> {
  data: Array<{ type: string; id: number | string; attributes: T }>;
  has_more?: boolean;
}

export interface SimpleMdmAppAttributes {
  name: string;
  app_type?: string;
  bundle_identifier?: string;
  version?: string;
}

// Confirmed against a real device response (2026-08-26, device id
// 2381595) - only the fields this Worker actually reads are kept here;
// the real response has many more (battery_level, firewall,
// recovery_lock_password, os_update, etc). `status` is a real
// enrollment-state word ("enrolled"), not a Fleet-style connectivity
// word - see simpleMdmClient.ts's getDeviceStatus doc comment.
// `enrollment_channel` (singular) never existed - the real field is
// `enrollment_channels` (plural, an array); removed rather than fixed,
// since nothing here actually needs it (getDeviceStatus now uses
// `status` directly instead).
export interface SimpleMdmDeviceAttributes {
  name?: string;
  device_name?: string;
  status?: string;
  last_seen_at?: string;
  os_version?: string;
  model_name?: string;
  serial_number?: string;
  filevault_enabled?: boolean;
}

// Confirmed against a real device response (2026-08-26) - and confirmed
// there is genuinely no status field of any kind (no verified/pending/
// failed concept exists here at all, unlike Fleet's own per-profile
// status). group_count/device_count exist in the real response too
// (how many groups/devices this profile is assigned to) but aren't
// currently read - see simpleMdmClient.ts's getDeviceStatus doc comment
// for what this means for the dashboard's MDM lockdown display.
export interface SimpleMdmProfileAttributes {
  name?: string;
  profile_identifier?: string;
}

// SimpleMDM's installed_apps is a plain app inventory (name/version/
// bundle identifier) - it does NOT expose per-app code-signing
// Team ID/cdhash the way Fleet's signature_information does. See
// simpleMdmClient.ts's getInstalledApps doc comment for what this
// means for the dashboard's one-click Santa-rule-from-installed-app
// feature.
export interface SimpleMdmInstalledAppAttributes {
  name: string;
  bundle_identifier?: string;
  identifier?: string;
  version?: string;
}
