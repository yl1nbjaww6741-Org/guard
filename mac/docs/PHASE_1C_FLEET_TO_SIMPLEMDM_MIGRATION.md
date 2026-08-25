# Phase 1c - Migrate off Fleet entirely, to SimpleMDM

**Plan only - not started, not acted on.** Written to think through the
decision properly before committing to it, per explicit instruction:
this is a reference document to come back to, not a runbook to run
today. Unlike `PHASE_1B_FLEET_HETZNER_MIGRATION.md` (which keeps Fleet,
just relocates where it's hosted), this is a genuinely different move:
**dropping Fleet as the MDM entirely** in favor of SimpleMDM, a hosted
SaaS MDM. If this is ever adopted, it replaces the Hetzner plan rather
than sitting alongside it - there'd be no Fleet stack left to relocate.

## Why this is even on the table

Real numbers, checked directly against each vendor's own site, not
guessed (see the conversation this doc is written from for the full
comparison table):

| | Fleet (current) | SimpleMDM |
|---|---|---|
| MDM license cost | Free tier: $0, but no Recovery Lock. **Premium: $7/mo/host** (own licensing choice, not an Apple restriction) | **$2.50-3.00/device/mo**, no minimum, single flat plan (no tier gating Recovery Lock separately) |
| Hosting | Self-hosted - MySQL + Redis + Fleet server + a Cloudflare Tunnel, currently 4 Fly.io apps (~$17 USD/mo), or the not-yet-executed Hetzner plan (~€4.35/mo) | **None** - SimpleMDM is Apple's-own-cloud-hosted, nothing of yours needs to be reachable at all |
| Total real monthly cost | ~$24 AUD (Fly) or Premium $7/mo + ~$7 AUD Hetzner once migrated | **~$2.50-4 USD flat**, full stop |

So the case for this isn't "Fleet is bad" - Phase 1 is fully built,
verified, and working today. It's that **SimpleMDM is cheaper than
Fleet Premium's license fee alone**, before counting hosting at all,
and it eliminates the entire self-hosting problem the Hetzner doc
exists to solve. Worth a real look before spending more effort
relocating Fleet's hosting.

## What stays exactly as-is

- **The Cloudflare Worker itself** (`worker/`) - dashboard, Santa sync
  server, the 24h ratchet mechanism. None of this is "hosted" in the
  VM sense today - it already runs serverless on Cloudflare, free
  tier. Switching MDM backends doesn't touch this fact either way.
- **Santa** (system extension, StaticRules, the sync protocol) -
  already syncs through this project's own Worker, not through Fleet
  directly (`SyncBaseURL` in `profiles/santa-config.mobileconfig`
  points at `panel.lukep009.download`). Completely unaffected by which
  MDM manages the Mac.
- **The dashboard's ratchet/password model** - `LOOSEN_PASSWORD_HASH`,
  the 24h delay, `pending_profile_changes` - all of that logic lives in
  this Worker, not in whichever MDM's API it happens to call at the
  end. No change to any of this project's actual security model.

## What has to change - the Worker's Fleet-specific integration code

Real files, read directly, not assumed - this is exactly what a switch
would touch:

| File | What it does today (Fleet) | What it'd need to become (SimpleMDM) |
|---|---|---|
| `worker/src/fleetClient.ts` | 7 functions: `uploadPackage`, `findHostId`, `installOnHost`, `getHostSoftware`, `getHostStatus`, `createConfigurationProfile`, `updateConfigurationProfile` - thin proxies to Fleet's real REST API | A new `simpleMdmClient.ts` with equivalent functions against SimpleMDM's real API (see table below) |
| `worker/src/softwareApi.ts` | `.pkg` upload/install route handlers, calling `fleetClient.ts` | Same route shapes, calling the new client instead |
| `worker/src/configProfilesApi.ts` | Config-profile upload/update route handlers (queues through the ratchet, `ratchet.ts` later calls Fleet) | Same - `ratchet.ts`'s `applyDueProfileChanges` would call the new client instead of Fleet's `createConfigurationProfile`/`updateConfigurationProfile` |
| `worker/src/hostStatus.ts` | Merges Santa sync health (D1) with Fleet's live host/MDM-profile status | Same shape, sourced from SimpleMDM's device-detail endpoint instead |
| `worker/src/types.ts` | `Fleet*` response types (`FleetHostDetail`, `FleetListHostsResponse`, etc.) | New `SimpleMdm*` types matching its real response shapes |
| `worker/wrangler.toml` secrets | `FLEET_BASE_URL`, `FLEET_API_TOKEN`, `DEFAULT_FLEET_HOST` | `SIMPLEMDM_API_KEY`, `DEFAULT_SIMPLEMDM_DEVICE_ID` (or similar) |
| `worker/src/configProfiles.ts` | Hand-kept mirror of each `.mobileconfig`'s real restrictions (unrelated to which MDM hosts them) | **Unchanged** - this is just documentation of profile content, not an API call |

Real SimpleMDM endpoints, checked directly against `api.simplemdm.com`'s
own docs - map cleanly onto what's there today:

| Fleet (today) | SimpleMDM (real endpoint) |
|---|---|
| `POST /api/v1/fleet/software/package` | `POST /api/v1/apps` (accepts `.pkg` directly) |
| `GET /api/v1/fleet/hosts?query=...` | `GET /api/v1/devices?search=...` |
| `POST /api/v1/fleet/hosts/:id/software/:title_id/install` | `POST /api/v1/devices/:id/push_apps` |
| `GET /api/v1/fleet/hosts/:id/software` | `GET /api/v1/devices/:id/installed_apps` |
| `GET /api/v1/fleet/hosts/:id` | `GET /api/v1/devices/:id` + `GET /api/v1/devices/:id/profiles` |
| `POST /api/v1/fleet/configuration_profiles` | `POST /api/v1/custom_configuration_profiles/` + `POST /api/v1/custom_configuration_profiles/:id/devices/:device_id` (create is a separate step from assignment) |
| `PATCH /api/v1/fleet/configuration_profiles/:uuid` | `PATCH /api/v1/custom_configuration_profiles/:id` |
| N/A (Fleet Premium's `enable_recovery_lock_password` setting) | `POST /api/v1/devices/:id/rotate_recovery_lock_password`, `POST /api/v1/devices/:id/clear_recovery_lock_password` |

One real structural difference worth designing around: SimpleMDM
separates **creating** a profile from **assigning** it to a device (two
calls, not one) - Fleet's own model doesn't have that distinction. Not
a blocker, just a real shape difference `configProfilesApi.ts`'s
replacement would need to account for.

## Real open questions - verify before starting, don't assume

Same discipline this whole project runs on - none of these are
confirmed yet, and each would change the plan:

- [ ] **Does the $2.50-3/device plan actually include Recovery Lock,
      with no further gate?** The `rotate_recovery_lock_password` API
      endpoint existing isn't proof by itself - SimpleMDM's own pricing
      page never explicitly says "Recovery Lock included." Confirm via
      their support chat, or by actually enrolling a test device on the
      free trial and checking the action is live, before trusting this
      as the reason to switch.
- [ ] **Is there a way to *retrieve* the current Recovery Lock password,
      not just rotate/clear it?** Only rotate/clear endpoints turned up
      in the docs check above - if reading the current value requires
      generating a new one, or is only ever shown once at rotation
      time, that changes what "check the Recovery Lock password" looks
      like operationally compared to Fleet's own dashboard-viewable
      value.
- [ ] **What does re-enrolling this specific Mac under a new MDM vendor
      actually require?** If the Mac is DEP/ADE-enrolled through Apple
      Business Manager (how "supervised" status usually gets set - see
      Phase 1's own status in `mac/README.md`), switching vendors
      likely means reassigning the device's MDM server in ABM, and
      possibly a full wipe-and-re-enroll depending on the current
      supervision path - not a hot-swap the way the Hetzner plan's
      tunnel-token reuse is. Confirm the exact mechanics (and whether a
      wipe is genuinely required or just a fresh MDM checkout) before
      treating this as low-risk.
- [ ] **Does SimpleMDM's `.pkg` install path (`POST /api/v1/apps` +
      `push_apps`) support the same install-script/self-service options
      Fleet's software library does?** Only matters if any current
      Santa/software deployment relies on those Fleet-specific options
      - worth a real check of what's actually used today in
      `worker/src/softwareApi.ts`'s callers before assuming a 1:1 swap.
- [ ] **Confirm the real trial doesn't require committing to an annual
      plan or entering billing details to test Recovery Lock/config
      profile behavior for real** - the free trial itself is confirmed
      card-free (SimpleMDM's own pricing page), but worth checking the
      specific features being evaluated here aren't trial-restricted in
      some other way.

## Suggested sequence, if this is ever adopted

Not detailed step-by-step the way the Hetzner runbook is (deliberately
- this is a plan to revisit, not a runbook to execute), but the real
shape it should take:

1. **Trial first, decide, then commit** - start SimpleMDM's free trial
   against a throwaway/test enrollment if at all possible (a spare
   device, or a controlled test) before touching the real, already-
   working Mac. Confirm the open questions above for real.
2. **Build the Worker-side integration against the trial**, in a branch,
   fully tested locally (`wrangler dev`) the same way every other piece
   of this project has been - before any real device re-enrollment
   happens. The code change is the low-risk, easily-reversible part;
   the Mac's actual MDM re-enrollment is the real one-way step.
3. **Only once the Worker side is proven** - re-enroll the real Mac,
   verify every one of Phase 1's original checklist items again
   (enrolled/supervised, all profiles applied, Recovery Lock set and
   tested, APNs push working) against SimpleMDM specifically.
4. **Decommission Fleet and its Fly.io apps** only after that full
   re-verification passes - same "don't touch the old thing until the
   new thing is proven" discipline as the Hetzner plan's own Phase 6/7.

## Relationship to the Hetzner plan

If this is adopted, `PHASE_1B_FLEET_HETZNER_MIGRATION.md` becomes moot
- there'd be no Fleet stack left to relocate. If SimpleMDM turns out
not to work out for some reason surfaced by the open questions above
(Recovery Lock not really included, re-enrollment more disruptive than
expected), the Hetzner plan is still the right fallback to keep Fleet
but cut its hosting cost. Not choosing between them yet - this doc
exists so that choice can be made with real information already
gathered, not from scratch later.
