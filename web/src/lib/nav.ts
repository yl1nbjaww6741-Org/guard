import { Shield, Server, AppWindow, HardDrive, Chrome, KeyRound } from "lucide-react";
import type { NavItem } from "./types";

// Reduced from DASHBOARD-PROMPT.md's original 17-page nav to the pages
// that have real backend data today - explicit choice, not a partial
// implementation of the rest. See the pages this session left out
// (WARP, Gateway policies, Bypass prevention, UniFi, AI blocker
// telemetry, Boot security, Permissions, both Android pages, Audit log)
// for why: none of them have a matching endpoint anywhere in this
// Worker, and this pass doesn't touch connectors/backend at all.
export const NAV: NavItem[] = [
  { id: "home", label: "Home", icon: Shield, group: null },
  { id: "fleet", label: "Fleet MDM", icon: Server, group: "Mac" },
  { id: "santa", label: "App control", icon: AppWindow, group: "Mac" },
  { id: "restrict", label: "Restrictions", icon: HardDrive, group: "Mac" },
  { id: "chrome", label: "Chrome policy", icon: Chrome, group: "Mac" },
  { id: "password", label: "Change password", icon: KeyRound, group: "Vault" },
];
