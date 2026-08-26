# Phase 1c - Migrate off Fleet entirely, to SimpleMDM

**In progress - decision made, migration underway.** Unlike
`PHASE_1B_FLEET_HETZNER_MIGRATION.md` (which keeps Fleet, just
relocates where it's hosted), this drops Fleet as the MDM entirely in
favor of SimpleMDM, a hosted SaaS MDM - saving ~$25 AUD/month (Fleet
Premium's $7/mo license fee plus Fly hosting, vs. SimpleMDM's flat
$2.50-3/device/mo with nothing to host). Adopting this makes the
Hetzner plan moot - there's no Fleet stack left to relocate once this
completes.

**Hands-on-hardware runbook, same shape as `PHASE_0_SETUP.md` and
`PHASE_5_LOCKDOWN.md` - Phases 1-4 below needed the physical Mac, Apple
Business Manager, and the SimpleMDM/Fleet consoles directly, and are
now done.** Phase 5 (the Worker code) is built and pushed, sitting at
`deploy-worker.yml`'s gated `deploy` job awaiting the remaining setup
below before it's safe to approve. Phase 6 (decommissioning Fleet)
needs your own confirmation before anything real gets destroyed.

## Status so far

- [x] SimpleMDM account created, Recovery Lock confirmed available on
      the plan, re-enrollment mechanics confirmed straightforward on
      this Mac's actual ABM setup
- [x] All 7 real `.mobileconfig` profiles uploaded to SimpleMDM as
      Custom Configuration Profiles (`chrome-policy`, `restrictions`,
      `santa-config`, `santa-tcc`, `system-extension`, `pppc`, `dns`)
- [x] Recovery Lock profile created in SimpleMDM's console
- [x] Device unenrolled from Fleet, enrolled in SimpleMDM
- [x] Profiles assigned to the real device
- [x] **Phase 4's full verification checklist passed** - Santa
      `Mode: Monitor` confirmed live (rules intact: Certificate 1,
      TeamID 1, plus a synced CDHash rule; sync to
      `panel.lukep009.download` confirmed still working, untouched by
      the MDM switch, exactly as designed), daemon communication
      working (no TCC error), plus the rest of the checklist (Chrome
      extension forced/locked, non-Chrome browsers refused, PPPC
      grants, DNS blocklist, Recovery Lock reboot-tested) all confirmed
      by the user directly
- [x] Worker code (`simpleMdmClient.ts` and callers) built, typechecked
      clean, `wrangler deploy --dry-run` verified - pushed, sitting at
      the gated `deploy` job
- [ ] `SIMPLEMDM_API_KEY` secret not yet set, real SimpleMDM device ID
      not yet plugged into `DEFAULT_SIMPLEMDM_DEVICE_ID` - **do this
      before approving the pending deploy**
- [ ] Fleet/Fly.io not yet decommissioned

## One real gap, found while building the Worker side - decide how to handle it

Checked directly against `api.simplemdm.com`'s own docs: **SimpleMDM
has no per-device, per-app targeted install.** Fleet's
`POST /hosts/:id/software/:title_id/install` lets your dashboard
install one specific package on one specific host in a single call.
SimpleMDM has no equivalent - app deployment is
**Assignment-Group-based**: create a group, assign the app to the
group, assign the device to the group, then `POST /devices/:id/push_apps`
installs *everything* assigned-but-not-installed on that device, not a
single targeted title.

This only affects the dashboard's "Install specific `.pkg` on this
Mac" feature (`worker/src/softwareApi.ts`) - it does not affect config
profiles, Recovery Lock, or host status, all of which map cleanly.
Three ways to handle it, pick one before Phase 4 starts on this piece
specifically:

1. **Build the Assignment Group dance for real parity** - more work,
   and the Assignment Group API's exact add-app/add-device shape isn't
   verified yet (would need another real docs check before trusting
   it).
2. **Simplify to `push_apps`'s real semantics** - drop per-app
   targeting, accept "install everything currently assigned to this
   Mac" as the new behavior. Least work, ships fastest.
3. **Defer this piece** - migrate config profiles/host status/Recovery
   Lock now (the clean, confirmed parts), leave `.pkg` installs on
   Fleet a little longer, come back to it once Assignment Groups are
   verified.

Not decided yet - flag which one before Phase 4 continues past config
profiles/host status.

## Why this is even on the table

Real numbers, checked directly against each vendor's own site, not
guessed:

| | Fleet (current) | SimpleMDM |
|---|---|---|
| MDM license cost | Free tier: $0, but no Recovery Lock. **Premium: $7/mo/host** (own licensing choice, not an Apple restriction) | **$2.50-3.00/device/mo**, no minimum, single flat plan (no tier gating Recovery Lock separately) |
| Hosting | Self-hosted - MySQL + Redis + Fleet server + a Cloudflare Tunnel, currently 4 Fly.io apps (~$17 USD/mo) | **None** - SimpleMDM is hosted SaaS, nothing of yours needs to be reachable at all |
| Total real monthly cost | ~$24-25 AUD | **~$2.50-4 USD flat**, full stop |

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

| File | What it does today (Fleet) | What it becomes (SimpleMDM) |
|---|---|---|
| `worker/src/fleetClient.ts` | 7 functions, thin proxies to Fleet's real REST API | New `worker/src/simpleMdmClient.ts` against SimpleMDM's real API |
| `worker/src/softwareApi.ts` | `.pkg` upload/install route handlers | Same routes, calling the new client - pending the app-install gap decision above |
| `worker/src/configProfilesApi.ts` | Queues profile changes through the ratchet (doesn't call Fleet directly) | **Unchanged** - only `ratchet.ts`'s apply step needs to change |
| `worker/src/hostStatus.ts` | Merges Santa sync health with Fleet's live host/MDM-profile status | Same shape, sourced from SimpleMDM's device-detail endpoint |
| `worker/src/ratchet.ts` | `applyDueProfileChanges` calls Fleet's create/update-configuration-profile | Calls SimpleMDM's create+assign / update instead |
| `worker/src/types.ts` | `Fleet*` response types, `Env`'s `FLEET_*` fields | New `SimpleMdm*` types, `SIMPLEMDM_API_KEY` / `DEFAULT_SIMPLEMDM_DEVICE_ID` |
| `worker/wrangler.toml` | `FLEET_BASE_URL`, `FLEET_API_TOKEN`, `DEFAULT_FLEET_HOST` | `SIMPLEMDM_API_KEY` (secret), `DEFAULT_SIMPLEMDM_DEVICE_ID` (var) |
| `worker/src/configProfiles.ts` | Hand-kept mirror of each `.mobileconfig`'s real restrictions | **Unchanged** - documentation, not an API call |

Real SimpleMDM endpoints, checked directly against `api.simplemdm.com`'s
own docs:

| Fleet (today) | SimpleMDM (real endpoint) |
|---|---|
| `POST /api/v1/fleet/software/package` | `POST /api/v1/apps` (multipart, field name `binary`) |
| `GET /api/v1/fleet/hosts?query=...` | `GET /api/v1/devices?search=...` |
| `POST /api/v1/fleet/hosts/:id/software/:title_id/install` | No 1:1 equivalent - see the gap above |
| `GET /api/v1/fleet/hosts/:id/software` | `GET /api/v1/devices/:id/installed_apps` |
| `GET /api/v1/fleet/hosts/:id` | `GET /api/v1/devices/:id` + `GET /api/v1/devices/:id/profiles` (exact response attribute names not yet confirmed against a real example - verify against a live device before trusting field names) |
| `POST /api/v1/fleet/configuration_profiles` | `POST /api/v1/custom_configuration_profiles/` (create) + `POST /api/v1/custom_configuration_profiles/:id/devices/:device_id` (assign - separate call) |
| `PATCH /api/v1/fleet/configuration_profiles/:uuid` | `PATCH /api/v1/custom_configuration_profiles/:id` |
| N/A (Fleet Premium's `enable_recovery_lock_password` setting) | A real device profile, created in SimpleMDM's console (per the confirmed screenshot) - not an ad-hoc API action the way Fleet's is |

**Auth is a real difference too**: Fleet uses a bearer token
(`Authorization: Bearer <token>`); SimpleMDM uses HTTP Basic with the
API key as the username and a blank password
(`Authorization: Basic base64(API_KEY:)`).

## Real open questions - one still open

- [x] Recovery Lock inclusion - confirmed by the user directly
- [x] Re-enrollment risk - confirmed straightforward by the user
      directly, not a wipe-and-redo
- [ ] **Can the current Recovery Lock password be retrieved, not just
      rotated/cleared?** SimpleMDM's console screen shown generates a
      random password per device at profile-assignment time - worth
      confirming where that generated value is actually viewable
      afterward (the device's own detail page, presumably) before
      relying on it the way Fleet's dashboard-viewable value works
      today.
- [ ] **The app-install gap above** - needs a decision, not just a fact
      to confirm.

## Step-by-step migration sequence

### Phase 1 - Final pre-cutover checks (you, on the real Mac/consoles) - done

- [x] Confirmed the 7 uploaded profiles in SimpleMDM's console match
      what's committed in this repo's `profiles/` directory
- [x] Recovery Lock profile created ("Generate a random password for
      each device," scoped to Apple Silicon)
- [x] SimpleMDM API key generated
- [x] App-install-gap decision made: option 2, simplify to
      `push_apps`'s real semantics (see that section above)

### Phase 2 - Unenroll from Fleet - done

1. Fleet's host page for this Mac -> Actions -> **Turn off MDM** (or
   equivalent unenroll action - exact wording depends on your Fleet
   version). This is the clean path Fleet itself provides, rather than
   pulling the device out from under it via Apple Business Manager
   directly.
2. Confirm on the Mac itself: `sudo profiles status -type enrollment`
   should show no active MDM enrollment (or `profiles list` no longer
   shows Fleet's enrollment profile).
3. **Do not delete anything in Fleet's own UI yet** (hosts, software
   library, config profiles) - keep it as a rollback reference until
   Phase 6 confirms SimpleMDM is fully working.

### Phase 3 - Enroll in SimpleMDM - done

1. In Apple Business Manager, reassign this device (serial
   `GGV7PVVR96`, per `wrangler.toml`'s own `DEFAULT_FLEET_HOST` value)
   from Fleet's MDM server entry to SimpleMDM's - this is the real
   mechanism per Apple's own DEP/ADE model, and what you've confirmed
   is straightforward on this Mac's actual setup.
2. The Mac should prompt to install the new (SimpleMDM) MDM profile on
   next enrollment check, or via **System Settings -> General ->
   Device Management** if it doesn't prompt automatically.
3. Confirm in SimpleMDM's console: the device shows as enrolled and
   supervised (not just "enrolled" - supervision is required for
   Recovery Lock and several of the restriction profiles to actually
   take effect).

### Phase 4 - Assign profiles, verify each one - done, all checks passed

1. In SimpleMDM, assign all 7 uploaded Custom Configuration Profiles
   plus the new Recovery Lock profile to this device (or a device
   group containing it).
2. Re-run Phase 1's own real verification checklist (from
   `mac/README.md`), this time against SimpleMDM instead of Fleet:
   - [x] `sudo profiles list` shows all 7 profiles applied
   - [x] Chrome shows the ContentGuard extension as "installed by your
         administrator," no remove control (chrome-policy.mobileconfig)
   - [x] Non-Chrome browsers (Safari included) still refused to launch
         (restrictions.mobileconfig)
   - [x] `sudo santactl status` shows `Mode: Monitor`, existing rules
         still enforced (santa-config.mobileconfig) - confirmed live:
         Certificate 1, TeamID 1 (the two StaticRules), plus a synced
         CDHash rule; sync to `panel.lukep009.download` still working,
         untouched by the MDM switch as designed
   - [x] `santactl status` no longer errors on daemon communication
         (santa-tcc.mobileconfig's Full Disk Access grants)
   - [x] Santa's System Extension activated without an interactive
         prompt (system-extension.mobileconfig)
   - [x] `ContentGuardAgent` still has Screen Recording/Accessibility
         without a re-grant prompt (pppc.mobileconfig)
   - [x] DoH-provider blocklist still active (dns.mobileconfig)
   - [x] Recovery Lock actually set - reboot-tested, asked for the
         password
3. **Every box above passed** - move to Phase 5.

### Phase 5 - Cut the Worker over (this session's part)

1. Resolve the app-install gap decision from Phase 1.
2. Build `worker/src/simpleMdmClient.ts` and repoint
   `softwareApi.ts`/`hostStatus.ts`/`ratchet.ts` (see the file table
   above) - happening in this session.
3. Test locally against `wrangler dev` using the real SimpleMDM API
   key from Phase 1 and this device's real SimpleMDM device ID.
4. Push to this branch - `deploy-worker.yml`'s gated `deploy` job will
   wait for your approval (the same `release` Environment used for
   the APK and D1 migrations) before it reaches the real, live Worker.
   **Do not approve that deploy until Phase 4 has fully passed** -
   approving it while the Mac is still mid-migration would point the
   live dashboard's Fleet-backed features at SimpleMDM for a device
   that isn't actually there yet.
5. Once approved and deployed, re-run Phase 4's checklist one more
   time through the dashboard itself (`/central/`'s Fleet MDM and App
   control tabs) rather than just the consoles directly - confirming
   the Worker's own view of the world matches reality.

### Phase 6 - Decommission Fleet and Fly.io

Only once Phase 5 fully passes:

```bash
fly apps destroy contentguard-fleet
fly apps destroy contentguard-fleet-mysql
fly apps destroy contentguard-fleet-redis
fly apps destroy contentguard-fleet-tunnel
```

- [ ] Cancel/downgrade the Fleet Premium subscription - the license
      fee doesn't stop on its own just because the Fly apps are gone.
- [ ] Remove `FLEET_BASE_URL`/`FLEET_API_TOKEN`/`DEFAULT_FLEET_HOST`
      from `worker/wrangler.toml` and unset the secrets
      (`wrangler secret delete`).
- [ ] Delete `worker/src/fleetClient.ts` once nothing imports it -
      unlike the abandoned Oracle doc (kept as a record of a blocked
      attempt), Fleet is being fully retired here, not just relocated,
      so this becomes genuinely dead code rather than a useful
      historical artifact.
- [ ] `PHASE_1B_FLEET_HETZNER_MIGRATION.md` becomes moot - mark it
      superseded the same way the Oracle doc was, rather than deleting
      it outright.

## Rollback

Fleet and its Fly.io apps stay untouched through Phase 5 - if anything
looks wrong at any point before Phase 6, reassign the device back to
Fleet's MDM server in Apple Business Manager and re-enroll there,
exactly reversing Phase 2/3. The Worker-side code change (Phase 5) is
also reversible on its own - `fleetClient.ts` isn't deleted until
Phase 6, so reverting the branch's deploy back to the pre-migration
commit restores Fleet-backed dashboard behavior immediately.

## What NOT to touch

- COMMAND (a different, unrelated repo - confirmed with the user
  earlier in this project, no special handling needed)
- MDM profiles' actual *content* - the same 7 `.mobileconfig` files,
  uploaded as-is; only which MDM vendor hosts/pushes them changes
- Santa's `SyncBaseURL` (`profiles/santa-config.mobileconfig`) -
  already points at this project's own Worker, not Fleet, unaffected
  either way
- `ContentGuardAgent`/`ContentGuardDaemon` - entirely local, no
  dependency on which MDM is enrolled
