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
  // accepted, not a hidden gap.
  CONTENTGUARD_EXTENSION_SYNC_TOKEN?: string;
  // Signs/verifies dashboard session cookies (session.ts) - internal
  // cryptographic key, not user-facing, so it stays a static Wrangler
  // secret rather than going through the password ratchet the way the
  // dashboard password itself does (see schema.sql's dashboard_auth
  // comment for why that one lives in D1 instead).
  SESSION_SIGNING_KEY?: string;
  // Fleet API credentials - see fleetClient.ts's doc comment for the
  // real API reference this was built against. FLEET_BASE_URL is the
  // real deployed Fleet URL (mac/fleet/README.md's `fleet.yourdomain.com`,
  // once real), not committed as a var since it's specific to this
  // project's own Fleet deployment, same "don't guess a real value"
  // treatment as everything else.
  FLEET_BASE_URL?: string;
  FLEET_API_TOKEN?: string;
  // Fleet host identifier (hostname/serial/UUID) to fall back to when
  // the "Installed apps" dashboard section isn't given an explicit one -
  // this project only ever has one real Mac in scope (see
  // mac/README.md's Phase 4 row's forward-compat note: generic enough
  // for a future second device, not actually built for one yet), so
  // requiring that identifier to be typed in every single time is pure
  // friction, not a real safeguard. Not a secret - a serial number isn't
  // sensitive the way FLEET_API_TOKEN is, so this is a plain wrangler.toml
  // [vars] entry, not a `wrangler secret put`. The host query param this
  // falls back from still works and always will, for the day a second
  // device is genuinely in scope.
  DEFAULT_FLEET_HOST?: string;
}

// --- Fleet's own REST API shapes (the subset this Worker uses) ---
// Built directly against fleetdm/fleet's docs/REST API/rest-api.md,
// fetched from the real repo, not guessed - see fleetClient.ts.

export interface FleetSoftwarePackage {
  title_id: number;
  name: string;
  version: string;
  platform: string;
  hash_sha256: string;
  uploaded_at: string;
}

export interface FleetAddPackageResponse {
  software_package: FleetSoftwarePackage;
}

export interface FleetHost {
  id: number;
  hostname: string;
}

export interface FleetListHostsResponse {
  hosts: FleetHost[];
}

// --- Get host's software (GET /api/v1/fleet/hosts/:id/software) ---
// Only the fields this Worker actually reads are kept required; Fleet's
// real response has many more (vulnerabilities, software_package,
// app_store_app, etc) - see fleetClient.ts's getHostSoftware doc comment
// for what this is used for and the identifier-type nuance.

export interface FleetSignatureInfo {
  installed_path: string;
  team_identifier: string | null;
  // Per Fleet's own docs (rest-api.md's "Get host's software" section):
  // "hash_sha256 is the cdhash_sha256" - this is a Santa CDHASH-type
  // identifier, NOT a binary SHA-256, despite the field name. Do not
  // treat it as a BINARY rule identifier.
  hash_sha256: string | null;
  executable_sha256: string | null;
}

export interface FleetInstalledVersion {
  version: string;
  bundle_identifier: string | null;
  signature_information: FleetSignatureInfo[] | null;
}

export interface FleetHostSoftwareItem {
  id: number;
  name: string;
  source: string;
  installed_versions: FleetInstalledVersion[] | null;
}

export interface FleetListHostSoftwareResponse {
  count: number;
  software: FleetHostSoftwareItem[];
}

// --- Get host (GET /api/v1/fleet/hosts/:id) ---
// Only the fields this Worker actually reads are kept required; Fleet's
// real response is much larger (users, geolocation, batteries, issues,
// etc) - see fleetClient.ts's getHostStatus doc comment for what this is
// used for.

export interface FleetMdmProfile {
  profile_uuid: string;
  name: string;
  // One of "pending" | "verifying" | "verified" | "failed" per Fleet's
  // own docs - not narrowed to a union here since Fleet's real set could
  // grow and a strict union would make this Worker fail to compile on a
  // status value it hasn't seen yet, for a field this Worker only ever
  // displays, never branches logic on.
  status: string;
  operation_type: string;
}

export interface FleetMdmInfo {
  enrollment_status: string;
  connected_to_fleet: boolean;
  profiles: FleetMdmProfile[];
}

export interface FleetHostDetail {
  hostname: string;
  status: string; // "online" | "offline" | "missing" per Fleet's own docs
  seen_time: string;
  os_version: string;
  disk_encryption_enabled: boolean | null;
  mdm: FleetMdmInfo | null; // null on a host that isn't MDM-enrolled at all
}

export interface FleetGetHostResponse {
  host: {
    hostname: string;
    status: string;
    seen_time: string;
    os_version: string;
    disk_encryption_enabled?: boolean;
    mdm?: {
      enrollment_status: string;
      connected_to_fleet: boolean;
      profiles?: FleetMdmProfile[];
    };
  };
}
