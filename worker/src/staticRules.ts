// Read-only mirror of profiles/santa-config.mobileconfig's StaticRules
// array - NOT fetched at runtime (this Worker has no access to Fleet's
// stored profile content, and parsing plist XML at runtime for two
// hand-maintained entries wasn't worth the complexity/dependency cost,
// same "minimal moving parts" reasoning as everywhere else in this
// project). The profile itself remains the actual source of truth and
// enforcement mechanism - this exists purely so the dashboard doesn't
// look like Santa is enforcing nothing when StaticRules is doing real
// work (found live: Tor Browser's block wasn't showing anywhere on the
// dashboard, which is misleading even though it's correct that this
// Worker's own `rules` table has nothing to do with it).
//
// MUST be kept in sync by hand whenever
// profiles/santa-config.mobileconfig's StaticRules array changes -
// deliberately a small, rarely-touched list (see that file's own
// StaticRules comment: "add entries as real gaps show up, not
// preemptively"), so the sync-drift risk this creates is low. Extracted
// directly from the real profile via `plistlib`, not retyped by hand.

import type { Policy, RuleType } from "./types";

export interface StaticRuleEntry {
  identifier: string;
  rule_type: RuleType;
  policy: Policy;
}

export const STATIC_RULES: StaticRuleEntry[] = [
  {
    identifier: "ef2d492485a1d4b3c74946ffc72da927862af3ea0205ffdd96b96ab3617bc31f",
    rule_type: "CERTIFICATE",
    policy: "ALLOWLIST",
  },
  {
    identifier: "MADPSAYN6T",
    rule_type: "TEAMID",
    policy: "BLOCKLIST",
  },
];
