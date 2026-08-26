# MDM profiles

Pushed to the Mac via Fleet (Phase 1). Every `PayloadUUID` here is a real,
freshly generated UUID - don't reuse one across profiles or re-generate
one in place without understanding why (Fleet/macOS key profile identity
partly off these).

| Profile | Status | Notes |
|---|---|---|
| `restrictions.mobileconfig` | Ready to push (v5) | `forceAdminPasswordForAppInstallation` deliberately set `false`, not the original spec's `true` - see below. Also see the flag below about `allowScreenshotsAndScreenRecording` before Phase 2. As of v4 (2026-08-25), also blocks every browser except the hardened Chrome stable channel via `blacklistedAppBundleIDs` (explicit user request); v5 (same day) deepened that list and added torrent/P2P clients to it - see the profile's own comment for the reasoning, confidence tiers, and its stated limitation. |
| `pppc.mobileconfig` | **Placeholder, signing strategy now decided** | Self-signed cert confirmed working via `mac/docs/PHASE_2_SIGNING_TEST.md` (all 3 tests passed on the real Mac - no Apple Developer ID needed). `__CODE_REQUIREMENT__` will be `identifier "com.contentguard.agent" and certificate root = H"cda6539309367d134e61fb248ba54c7e1386268e"` once the real agent is signed with the same `"ContentGuard Signing"` login-keychain cert - `__BUNDLE_ID__` becomes `com.contentguard.agent`. Push as-is for now - it matches nothing until Phase 2's agent exists. |
| `chrome-policy.mobileconfig` | Ready to push | |
| `dns.mobileconfig` | Ready to push | `ServerURL` is this org's real Gateway DoH endpoint, read from `warp-cli settings` in Phase 0. Re-check that value if Gateway config ever changes. |
| `system-extension.mobileconfig` | **Placeholder, and won't apply to WARP** | Checked on the real Mac in Phase 1: WARP's packet tunnel runs as a Network (App) Extension, not a System Extension - `systemextensionsctl list` shows 0 extensions even with WARP connected, so this payload type doesn't govern it. Cloudflare's Team ID (`68WVV388M8`) is recorded in the profile's comment for reference only. This profile's real first use is Santa in Phase 3, whose EndpointSecurity component does use System Extensions - `__SANTA_TEAM_ID__`/`__SANTA_EXTENSION_BUNDLE_ID__` get filled in then. |
| `background-task-management.mobileconfig` | Ready to push (2026-08-26) | Closes a real gap found live on the Mac: `com.contentguard.daemon`/`com.contentguard.agent` showed up as freely toggleable "Allow in the Background" items in System Settings, with no lock at all - a local admin could kill the entire enforcement stack with two clicks and no sudo. Uses the `com.apple.servicemanagement` payload's `Rules` (`Label` match on both ContentGuard launchd jobs, `TeamIdentifier` match on Santa's real Team ID `ZMCG7MLDV9`, same value already confirmed in `system-extension.mobileconfig`) to mark both as MDM-managed and non-removable via that UI. See the profile's own comment for the full reasoning and how to verify it applied. |

## Deliberate deviation: `forceAdminPasswordForAppInstallation = false`

The original spec had this `true`. Changed to `false` mid-Phase-1 for a
reason that only makes sense combined with two other deliberate
decisions already made: Santa stays in MONITOR/blocklist mode (Phase 3,
not LOCKDOWN/allowlist), and the Phase 2 content-capture blocker catches
NSFW content regardless of which app displayed it - same model the
Android app already uses successfully. Given that, gating installation
behind admin/vault friction was adding cost without covering a threat
the other two layers don't already cover for the actual goal (blocking
NSFW content) - so standard users (post-Phase 5) install freely.

**Known gap this leaves, on purpose, not by oversight**: a freely
installed tool that doesn't display NSFW content but instead targets
the enforcement stack itself (killing `ContentGuardDaemon`, revoking
Screen Recording, disabling WARP) produces nothing for the content
blocker to catch, and MONITOR-mode Santa won't stop it running unless
it's already denylisted. The compensating control for *this specific
gap* is Phase 2's daemon being designed as tamper-resistant on its own
(fails closed on permission loss, escalates to a hard lock on
kill-loops rather than just dying) - not this restriction, and not
Santa. If Phase 2's daemon doesn't hold up to that standard in practice,
this decision is worth revisiting.

If you ever switch Santa to LOCKDOWN (allowlist), `false` here becomes
strictly safer than `true` - free installation is harmless once
execution itself is the actual gate. It's the blocklist choice that
makes this a real tradeoff rather than a free win.

## Known open risk: `allowScreenshotsAndScreenRecording` vs. Phase 2

`restrictions.mobileconfig` sets `allowScreenshotsAndScreenRecording` to
`false`, per the original build spec. This is a supervised-only MDM
restriction that blocks the interactive screenshot shortcuts
(`Cmd+Shift+3/4/5`) and Control Center's manual screen recording - which
is a reasonable hardening step on its own (stops screenshotting evidence
of blocked content, etc).

**What's not yet confirmed**: whether this restriction also blocks
`ContentGuardAgent`'s own `ScreenCaptureKit` capture once Phase 2 grants
it Screen Recording via the PPPC profile. If Apple's MDM restriction
operates at the same layer as TCC's per-app grant, this could silently
disable the entire blocker the moment this profile is pushed - the
opposite of what `forceBypassScreenCaptureAlert` (also in this profile)
is *for* (suppressing the recording-in-progress nag implies something is
expected to actually be recording).

Verification test #2 in Phase 1's checklist ("no monthly capture nag")
partially covers this but isn't definitive on its own, since that test
happens before ContentGuardAgent exists. **Once Phase 2's agent is built
and PPPC-approved, explicitly re-verify `SCStream` capture still works
with this restriction active** before relying on it - if it turns out
blocked, the fix is likely scoping this restriction differently or
dropping it from this profile, not abandoning the restriction goal
entirely.

## Pushing via SimpleMDM

Fleet was dropped entirely in favor of SimpleMDM - see
`mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md`. Push a profile from
this directory via SimpleMDM's own dashboard: **Configuration Profiles >
Add Profile > Custom Configuration Profile**, upload the `.mobileconfig`
file as-is, then assign it to the Mac's group/device. SimpleMDM handles
delivery to the enrolled Mac from there - no Worker-side action needed
for a first push (the Worker's `createConfigurationProfile`/
`updateConfigurationProfile` in `worker/src/simpleMdmClient.ts` only come
into play for the ratchet's own scheduled *updates* to an
already-existing profile, not initial upload).
