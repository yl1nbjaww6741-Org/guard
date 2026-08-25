// Types matching the REAL Worker API's actual response shapes - read
// directly out of worker/src/dashboard.ts's existing fetch/render code
// (the same endpoints that page already calls, working end-to-end today),
// not DASHBOARD-PROMPT.md's aspirational generic contract
// (ContentGuardState/SystemStatus/etc., which doesn't exist server-side).
// Per explicit instruction, this pass only changes the UI - the existing
// backend's real shapes win over the new prompt's imagined ones.

import type { LucideIcon } from "lucide-react";

// --- Santa rules (/api/rules, /api/static-rules, /api/loosen-requests) ---

export type RuleType = "TEAMID" | "CERTIFICATE" | "BINARY" | "SIGNINGID" | "CDHASH";
export type Policy = "ALLOWLIST" | "BLOCKLIST" | "SILENT_BLOCKLIST" | "REMOVE";

export interface StaticRule {
  name: string;
  identifier: string;
  rule_type: RuleType;
  policy: Policy;
}

export interface Rule {
  id: number;
  notification_app_name: string | null;
  identifier: string;
  rule_type: RuleType;
  policy: Policy;
  device_id: string | null;
}

export interface LoosenRequest {
  id: number;
  rule_id: number;
  applies_at: number;
}

// --- Safe apps (/api/safe-apps, /api/static-safe-apps, /api/safe-app-additions) ---

export interface StaticSafeApp {
  name: string;
  bundleId: string;
}

export interface SafeApp {
  bundle_id: string;
  name: string | null;
  added_at: number;
}

export interface SafeAppAddition {
  id: number;
  bundle_id: string;
  name: string | null;
  applies_at: number;
}

// --- Installed apps (/api/installed-software, /api/known-apps) ---

export interface InstalledApp {
  name: string;
  version: string | null;
  bundle_identifier: string | null;
  identifier: string | null;
  rule_type: RuleType | null;
}

export interface KnownApp {
  name: string;
  bundleId: string;
}

// --- Host status (/api/host-status) ---

export interface MdmProfileStatus {
  name: string;
  profile_uuid: string;
  status: string; // Fleet's own status string, e.g. "verified"/"pending"/"failed"
}

export interface FleetStatus {
  status: string;
  seen_time: string;
  disk_encryption_enabled: boolean | null;
  mdm: {
    enrollment_status: string;
    connected_to_fleet: boolean;
    profiles: MdmProfileStatus[];
  } | null;
}

export interface SantaDevice {
  hostname: string | null;
  machine_id: string;
  client_mode: string;
  last_preflight_at: number | null;
}

export interface HostStatus {
  fleet: FleetStatus | null;
  fleetError?: string;
  devices: SantaDevice[];
}

// --- Config profile detail (/api/config-profile-details), the hand-kept
// mirror of what each real .mobileconfig actually restricts ---

export interface ConfigProfileDetail {
  name: string;
  file: string;
  payloadIdentifier: string;
  restrictions: string[];
}

export interface PendingProfileChange {
  id: number;
  action: "create" | "update";
  filename: string | null;
  profile_uuid: string | null;
  applies_at: number;
  apply_error: string | null;
}

// --- Pending password change (/api/password/pending-change) ---

export interface PendingPasswordChange {
  id: number;
  applies_at: number;
}

// --- Nav ---

export type NavGroup = "Mac" | "Vault" | null;

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
}
