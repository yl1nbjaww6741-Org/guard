// Common built-in Apple apps (Notes, Mail, Photos, etc.) pinned to the top
// of the dashboard's Installed Apps table - see dashboard.ts's
// loadInstalledApps() for how they're merged in. Added because Fleet's
// macOS applications inventory (softwareApi.ts's handleListInstalledSoftware,
// `macos_applications=true`) isn't reliable for apps living in
// /System/Applications the way it is for /Applications - a real
// first-party Apple app can go missing from that list even though it's
// obviously installed on every Mac, which made it impossible to
// whitelist/block/allow by name the way every other app on this
// dashboard already works, exactly the "add new apps only by title, not
// bundle ID" requirement this whole Installed Apps table exists for.
//
// Bundle IDs are Apple's own well-known, stable identifiers for these
// apps (unchanged across macOS versions for years) - not sourced from
// live inspection of this project's real Mac, since this Worker has no
// channel back to it (same reasoning as staticSafeApps.ts/staticRules.ts
// hand-kept mirrors). If Fleet's own inventory DOES report one of these
// (macos_applications improves, or a future Fleet version covers
// /System/Applications), loadInstalledApps() prefers Fleet's real row -
// this list is only a fallback stand-in, not a source of truth.
export interface KnownAppEntry {
  bundleId: string;
  name: string;
}

export const KNOWN_APPLE_APPS: KnownAppEntry[] = [
  { bundleId: "com.apple.Notes", name: "Notes" },
  { bundleId: "com.apple.mail", name: "Mail" },
  { bundleId: "com.apple.Photos", name: "Photos" },
  { bundleId: "com.apple.Preview", name: "Preview" },
  { bundleId: "com.apple.QuickTimePlayerX", name: "QuickTime Player" },
  { bundleId: "com.apple.reminders", name: "Reminders" },
  { bundleId: "com.apple.TextEdit", name: "TextEdit" },
];
