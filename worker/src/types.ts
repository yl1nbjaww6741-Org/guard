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
  // Both secrets, not vars - set via `wrangler secret put`, never
  // committed. See auth.ts's doc comments for what each actually gates
  // and why they're deliberately separate from each other.
  API_TOKEN?: string;
  LOOSEN_PASSWORD_HASH?: string;
}
