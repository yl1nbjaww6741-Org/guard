// Read-only, hand-kept summary of what each real profile in profiles/
// actually restricts - same pattern and same caveat as staticRules.ts:
// this Worker has no way to parse the real plist XML content Fleet has
// stored server-side at runtime without a real plist parser (a
// dependency this project has deliberately avoided everywhere else -
// see e.g. worker/src/auth.ts's history dropping `jose`), so this is a
// direct-from-source extraction (Python's plistlib, run once against the
// real files in profiles/, not retyped or guessed) rather than something
// computed live. MUST be kept in sync by hand whenever a profile's real
// content changes - matched to Fleet's own MDM profile list by `name`
// (Fleet reports each profile's own PayloadDisplayName as `name` in
// GET .../hosts/:id's mdm.profiles - confirmed via Fleet's real "Get
// host" docs), so a mismatch here just means "no local detail available
// for this one" rather than a wrong match.
//
// Extracting these surfaced one real, previously-unknown bug along the
// way: profiles/system-extension.mobileconfig had an invalid XML
// comment (a literal `--` inside a comment body, RFC-invalid, same bug
// class already caught once in this project's history with
// distribution.xml) - Apple's/Fleet's own plist parsers tolerated it,
// but Python's strict `plistlib` (used to extract this file) didn't.
// Fixed at the source (comment-only, no functional change, no
// PayloadVersion bump or Fleet repush needed).

export interface ConfigProfileDetail {
  name: string;
  file: string;
  payloadIdentifier: string;
  restrictions: string[];
}

export const CONFIG_PROFILES: ConfigProfileDetail[] = [
  {
    name: "ContentGuard Chrome Policy",
    file: "profiles/chrome-policy.mobileconfig",
    payloadIdentifier: "com.contentguard.chrome",
    restrictions: [
      "Incognito mode: disabled",
      "Guest mode: disabled",
      "Developer tools: disabled",
      "All extension installs: blocked (ExtensionInstallBlocklist: *)",
      "Chrome's own DNS-over-HTTPS: off (Gateway's DoH-provider block already covers this at the network level - this closes the same gap inside Chrome specifically)",
      "Browser sign-in: disabled",
    ],
  },
  {
    name: "ContentGuard DNS",
    file: "profiles/dns.mobileconfig",
    payloadIdentifier: "com.contentguard.dns",
    restrictions: [
      "DNS forced to Cloudflare Gateway's own DoH endpoint (DNSProtocol: HTTPS)",
      "Cannot be disabled by the user (ProhibitDisablement: true)",
    ],
  },
  {
    name: "ContentGuard PPPC",
    file: "profiles/pppc.mobileconfig",
    payloadIdentifier: "com.contentguard.pppc",
    restrictions: [
      "Accessibility access pre-approved for com.contentguard.agent (Allow) - lets the agent function without an interactive click, per its own CodeRequirement match",
    ],
  },
  {
    name: "ContentGuard Restrictions",
    file: "profiles/restrictions.mobileconfig",
    payloadIdentifier: "com.contentguard.restrictions",
    restrictions: [
      "iCloud Private Relay: blocked",
      "Erase All Content and Settings: blocked",
      "AirDrop: blocked",
      "Creating new local user accounts: blocked",
      "Modifying the existing account (e.g. changing admin status): blocked",
      "Installing configuration profiles via the UI: blocked (profiles only arrive via Fleet/MDM)",
      "Changing the startup disk: blocked",
      "Admin password for app installation: NOT required (deliberate - standard users install freely, see mac/README.md's Phase 3 row)",
      "Screenshots and screen recording: blocked",
      "The 'someone is recording your screen' system alert: suppressed (forceBypassScreenCaptureAlert - needed so ContentGuardAgent's own legitimate capture doesn't nag the user)",
    ],
  },
  {
    name: "ContentGuard Santa Configuration",
    file: "profiles/santa-config.mobileconfig",
    payloadIdentifier: "com.contentguard.santa",
    restrictions: [
      "Client mode: MONITOR (not LOCKDOWN - a deliberate decision, see this file's own comment)",
      "Sync server: this dashboard's own Worker (SyncBaseURL)",
      "2 permanent StaticRules regardless of sync state - see the Santa rules table above for what they are",
      "Event logging: syslog",
    ],
  },
  {
    name: "ContentGuard Santa Full Disk Access",
    file: "profiles/santa-tcc.mobileconfig",
    payloadIdentifier: "com.contentguard.santatcc",
    restrictions: [
      "Full Disk Access pre-approved for all three of Santa's own components (daemon, netd, bundleservice) - needed for santactl/the sync daemon to function at all",
    ],
  },
  {
    name: "ContentGuard System Extensions",
    file: "profiles/system-extension.mobileconfig",
    payloadIdentifier: "com.contentguard.systemextensions",
    restrictions: [
      "Santa's System Extension (EndpointSecurity) pre-approved for Santa's real Team ID (ZMCG7MLDV9) - daemon + netd - so activation doesn't need an interactive click",
    ],
  },
];
