// Read-only mirror of mac/Shared/Config.swift's ContentGuardConfig.safeAppBundleIDs
// - NOT fetched at runtime (this Worker has no channel back to a Mac's
// compiled Swift source), same "minimal moving parts" reasoning as
// staticRules.ts's identical mirror of santa-config.mobileconfig's
// StaticRules array. Exists purely so the dashboard's Safe Apps section
// is honest: without this, it looked like nothing was excluded from
// capture even though 5 apps have been excluded the whole time - the
// exact same misleading-empty-table problem staticRules.ts already found
// and fixed for Santa's StaticRules (see that file's own doc comment).
//
// MUST be kept in sync by hand whenever Config.swift's safeAppBundleIDs
// changes - deliberately a small, rarely-touched list (that constant's
// own doc comment: "Keep this list short and deliberate"), so the
// sync-drift risk this creates is low.

export interface StaticSafeAppEntry {
  bundleId: string;
  // Human-readable label - not part of Config.swift's own data (a bare
  // Set<String>), added purely so the dashboard doesn't show a bare
  // bundle identifier with no indication of what it actually is, same
  // reasoning as StaticRuleEntry.name in staticRules.ts.
  name: string;
}

export const STATIC_SAFE_APPS: StaticSafeAppEntry[] = [
  { bundleId: "com.apple.Terminal", name: "Terminal" },
  { bundleId: "com.apple.finder", name: "Finder" },
  { bundleId: "com.apple.systempreferences", name: "System Settings" },
  { bundleId: "com.apple.dt.Xcode", name: "Xcode" },
  { bundleId: "com.apple.ActivityMonitor", name: "Activity Monitor" },
];
