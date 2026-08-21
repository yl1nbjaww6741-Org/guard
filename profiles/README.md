# MDM profiles

Pushed to the Mac via Fleet (Phase 1). Every `PayloadUUID` here is a real,
freshly generated UUID - don't reuse one across profiles or re-generate
one in place without understanding why (Fleet/macOS key profile identity
partly off these).

| Profile | Status | Notes |
|---|---|---|
| `restrictions.mobileconfig` | Ready to push | See the flag below about `allowScreenshotsAndScreenRecording` before Phase 2. |
| `pppc.mobileconfig` | **Placeholder** | `__BUNDLE_ID__`/`__CODE_REQUIREMENT__` get filled in once Phase 2 builds and signs `ContentGuardAgent`. Push as-is for now - it matches nothing until then. |
| `chrome-policy.mobileconfig` | Ready to push | |
| `dns.mobileconfig` | Ready to push | `ServerURL` is this org's real Gateway DoH endpoint, read from `warp-cli settings` in Phase 0. Re-check that value if Gateway config ever changes. |
| `system-extension.mobileconfig` | **Placeholder** | `__CLOUDFLARE_TEAM_ID__`/`__CLOUDFLARE_WARP_EXTENSION_BUNDLE_ID__` need pulling from the Mac (`codesign`/`systemextensionsctl` - see the profile's own comment) before this does anything. Santa's entry gets added here in Phase 3. |

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

## Pushing via Fleet

Once Fleet is up (`mac/fleet/`) and the Mac is enrolled: Fleet's UI has a
**Controls > OS settings > Custom settings** (or similar, depending on
Fleet version) section for uploading `.mobileconfig` profiles and
assigning them to a team/host. Upload each file from this directory
as-is; Fleet handles delivery to the enrolled Mac.
