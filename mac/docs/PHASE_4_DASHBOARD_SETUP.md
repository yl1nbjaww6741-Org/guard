# Cloudflare Worker + dashboard setup (Phase 4)

Scope and the three design decisions behind it (ratchet mechanics,
dashboard auth via Cloudflare Access, Santa+Fleet-only for now) are
already made and documented in `mac/README.md`'s Phase 4 row - not
revisited here. This doc tracks what's actually been built and verified
versus what's still ahead, the same way `PHASE_3_SANTA_SETUP.md` did for
Santa.

## What's real and verified so far

`worker/` - a Cloudflare Worker implementing Santa's sync protocol
end-to-end. Built directly against `northpolesec/protos`' `sync/v1.proto`
(cloned and read for real, not guessed from secondhand docs - a WebFetch
of the buf.build docs page came back empty since it's a JS-rendered SPA,
and this project already has one instance this session of an indirect
fetch giving inconsistent answers for something exact-value-sensitive -
not repeating that mistake for a whole protocol implementation).

- `worker/schema.sql` - D1 schema: `devices`, `rules` (nullable
  `device_id` - NULL means "applies to every device", see the
  forward-compat note in `mac/README.md`'s Phase 4 row), `events`, and
  `pending_loosen_requests` (the ratchet mechanism's queue table - not
  wired up to any code yet, see below).
- `worker/src/types.ts` - TypeScript types matching the proto's
  `json_name` fields exactly, since Santa's default sync transport is
  JSON (confirmed via northpole.dev/features/sync/ - binary protobuf
  transfer is opt-in via `SyncEnableProtoTransfer`, not implemented
  here).
- `worker/src/santaSync.ts` + `db.ts` - the four sync stages
  (preflight, eventupload, ruledownload, postflight), routed by
  `worker/src/index.ts` matching the proto's real URL pattern
  (`POST /{stage}/{machine_id}`).

**Verified locally, not just written and assumed correct** - `npx tsc
--noEmit` passes clean, `schema.sql` applies cleanly to a real local D1
instance (`wrangler d1 execute --local`), and a real `wrangler dev`
instance was exercised with actual HTTP requests shaped like real Santa
traffic:

- `preflight` for a new machine correctly upserts the device and returns
  `{"client_mode":"MONITOR","batch_size":50}`.
- Two rules shaped exactly like this project's real ones (Tor Browser's
  TEAMID BLOCKLIST, `MADPSAYN6T`; ContentGuard's own CERTIFICATE
  ALLOWLIST, `ef2d4924...17bc31f` - the same real values already
  confirmed on the Mac and live in `profiles/santa-config.mobileconfig`)
  round-tripped through `ruledownload` correctly, and correctly returned
  empty on a second call (already-synced rules aren't resent, matching
  `SyncType.NORMAL`'s semantics from the proto).
- `postflight` accepted correctly.
- Both error paths work: a `machine_id` mismatch between the URL and the
  request body returns 400, an unknown route returns 404.

## Also real and verified: the ratchet mechanism

`POST /api/rules` tightens immediately (new/edited rule, no delay).
`POST /api/rules/:id/loosen-request` is the only way to loosen one
(`BLOCKLIST` -> `REMOVE`) - requires a password re-check
(`LOOSEN_PASSWORD_HASH`, a SHA-256 digest, never the raw password) and
queues a `pending_loosen_requests` row with `applies_at` set to exactly
24 hours out. A Cloudflare Cron Trigger (`worker/wrangler.toml`, every 15
minutes) applies anything due. `POST /api/loosen-requests/:id/cancel`
cancels a queued one before it applies - no password needed to cancel,
only to start a loosen.

All of it gated by an interim `API_TOKEN` bearer check (`worker/src/auth.ts`)
since the rule-management API can add/remove real enforcement rules and
Cloudflare Access isn't wired in yet - not the real access-control story
for this project, a stopgap until it is.

Verified against a real local `wrangler dev` instance: tighten, list,
reject-direct-REMOVE, wrong-password 403, correct-password 202 with
`applies_at` confirmed exactly `requested_at + 24h`, duplicate-request
409, nonexistent-rule 404, the scheduled handler (triggered via
`wrangler dev`'s real `/__scheduled` endpoint, not simulated) correctly
flipping a due rule to `REMOVE`, and a separately-cancelled request
correctly *not* applying even when forced due and the scheduled handler
re-run.

## Also real and verified: Fleet API integration

`worker/src/fleetClient.ts` implements the three Fleet REST API
endpoints this needs, built directly against `fleetdm/fleet`'s own
`docs/REST API/rest-api.md` (fetched from the real repo, not guessed):
upload (`POST /api/v1/fleet/software/package`), find a host by
hostname/serial/UUID (`GET /api/v1/fleet/hosts?query=...`), and trigger
an install (`POST /api/v1/fleet/hosts/:id/software/:title_id/install`).
New routes: `POST`/`GET /api/software` (upload, list what's been
uploaded - tracked in a new `software_packages` table) and
`POST /api/software/:titleId/install` (resolves a human-meaningful host
identifier first, never a raw Fleet host ID directly from a caller).

**Verified against a real mock server speaking Fleet's documented API
shape** (this sandbox has no network access to the actual deployed Fleet
instance, and shouldn't be making unsupervised changes to production
infra anyway) - confirmed a real multipart upload reaches the endpoint
correctly, the response is parsed and recorded correctly, install
resolves a hostname to a host ID before calling Fleet, an unknown
hostname 404s rather than silently no-op'ing, and `FLEET_API_TOKEN`
(forwarded to Fleet) is never confused with `API_TOKEN` (this Worker's
own dashboard gate) - confirmed as two genuinely distinct secrets via
the mock server's own request log, not just intended to be. **This
proves the Worker's own request construction is correct against the
documented contract - it does NOT prove Fleet's real server accepts
these exact requests**, which still needs the real deployed instance and
real credentials (see setup steps below, not run yet).

## Also real and verified: Cloudflare Access auth

`worker/src/cloudflareAccess.ts` verifies Access JWTs (`Cf-Access-Jwt-Assertion`
header, RS256 against Access's real JWKS endpoint, `aud`/`iss` claim
checks) using `jose`, built against Cloudflare's own documented method
(not guessed). Replaces the earlier interim `API_TOKEN` stopgap entirely
on all `/api/...` routes - decided in favor of replacing rather than
layering both, since a Cloudflare-signed per-session JWT is strictly
stronger than a static shared token and keeping both would add
complexity without adding real security.

`LOOSEN_PASSWORD_HASH` is set to the same real password as the Access
login itself - the user's explicit, informed choice (simplicity over the
extra friction a genuinely separate credential would add). The two
checks stay functionally independent in code regardless - the loosen
password is still re-checked separately at the moment of a loosen
request, never skipped just because Access already passed.

**Verified in two parts**, since Access's real JWKS endpoint is TLS-only
and this sandbox can't cheaply fake that:
1. The security-critical part (signature + claims verification) tested
   directly with the exact same `jose` calls this code makes, against
   real RSA-signed test tokens from a local mock JWKS server: valid
   token accepted; wrong-audience, expired, tampered-signature, and
   garbage tokens all correctly rejected (5/5 correct outcomes).
2. The route-level fail-closed paths tested through a live `wrangler dev`
   instance: no Access config at all correctly 500s ("not configured")
   on every `/api/...` route rather than silently allowing access;
   config set but no `Cf-Access-Jwt-Assertion` header correctly 401s, on
   both the rules and software APIs.

**Not verified**: an actual end-to-end request through a real deployed
Access Application - needs real Zero Trust configuration, not done yet
(see setup steps below).

## Also real and verified: the dashboard itself

`worker/src/dashboard.ts` - a single-page HTML+vanilla-JS dashboard
(no build step, no external CDN dependency), served at `GET /` by the
Worker itself, gated by the same `requireCloudflareAccess` check as
every `/api/...` route. Two sections matching the "single control
panel" scope: Santa rules (list, add, request-loosen with a password
prompt, cancel a pending loosen, a live countdown to when a queued
loosen applies) and Fleet software (list, upload, install on a host).

One small backend addition the dashboard needed: `GET /api/loosen-requests`,
listing every loosen request still in flight - `db.ts`'s
`listActiveLoosenRequests`.

**Verified against a real headless Chromium browser** - this sandbox
can't complete an actual Cloudflare Access login, so the page was
served by a local mock server implementing this project's real API
response shapes, bypassing only the Access gate itself, not the
dashboard's own logic. Confirmed: both tables render correctly from
real-shaped data, and all five interactive actions (add rule,
request-loosen with its password dialog, cancel, install-on-host with
its own prompt) fire the exact right HTTP method/path/JSON body. `GET /`
also confirmed to fail closed (500) with no Access config, same as the
API routes.

**Phase 4's original scope is now fully built and verified** - Santa
sync, ratchet, Fleet API, Cloudflare Access, and the dashboard. Real
Cloudflare deployment (see setup steps below) is the one remaining step.

## StaticRules vs. sync - decided

`profiles/santa-config.mobileconfig`'s existing `StaticRules` (Tor
Browser's BLOCKLIST, ContentGuard's own self-allowlist) **stay exactly
as they are, permanently, regardless of this Worker's sync server going
live.** They are not migrated to dynamic rules and this Worker's rule
set is not treated as a replacement for them. Reasoning: `StaticRules`
live in an MDM-pushed configuration profile - tamper-resistant in a way
a network service fundamentally can't be, since they keep working even
if this Worker goes down, gets misconfigured, or is ever compromised.
That guarantee is worth more than dashboard convenience for the small,
deliberately-hand-maintained set of rules that already exist. Confirmed
with the user before treating this as settled, same bar as
ScreenCapture's removal.

**What this Worker's rule set is actually for**: new rules added *after*
Phase 4, day-to-day, without needing a full profile edit-and-repush
cycle through Fleet every time (the whole reason Phase 4 exists per its
"single control panel" scope decision). `worker/schema.sql`'s `rules`
table and `StaticRules` are two independent, additive enforcement
sources from Santa's perspective - a binary gets blocked if *either*
denies it, not "whichever one wins."

## Real infra setup steps (not run yet)

None of this has been done on a real Cloudflare account yet - `wrangler.toml`
has two placeholders (`__CLOUDFLARE_ACCOUNT_ID__`, `__D1_DATABASE_ID__`),
same pattern as every other real-value placeholder in this repo.

1. `cd worker && npx wrangler login` (authenticates the CLI to your real
   Cloudflare account).
2. `npx wrangler d1 create contentguard` - creates the real D1 database
   and prints its ID. Fill that into `wrangler.toml`'s
   `__D1_DATABASE_ID__`.
3. Fill in `__CLOUDFLARE_ACCOUNT_ID__` (visible in the Cloudflare
   dashboard's sidebar, or `wrangler whoami`).
4. `npm run db:migrate:remote` - applies `schema.sql` to the real,
   remote D1 database (mirrors the local verification already done
   above).
5. `npm run deploy` - first real deploy, to a `workers.dev` subdomain by
   default.
6. In Cloudflare's Zero Trust dashboard, create an Access Application
   pointing at that Worker's route, using the same Access policy already
   locked down in Phase 1. Note its team domain and AUD tag - both
   shown in the Application's settings once created.
7. Set the secrets `worker/src/auth.ts`, `worker/src/cloudflareAccess.ts`,
   and `worker/src/fleetClient.ts` need (all fail closed if left unset,
   so none of this needs to happen before the deploy above):
   ```bash
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN   # from step 6
   npx wrangler secret put CF_ACCESS_AUD           # from step 6
   # LOOSEN_PASSWORD_HASH must be a SHA-256 hex digest, not the raw
   # password - e.g. on macOS: echo -n 'your real password' | shasum -a 256.
   # Deliberately set to the SAME password as your Cloudflare Access
   # login - see this file's "Cloudflare Access auth" section above for
   # why that's a real, considered tradeoff and not an oversight.
   npx wrangler secret put LOOSEN_PASSWORD_HASH
   # Fleet's own UI: "My account" -> "Get API token"
   npx wrangler secret put FLEET_BASE_URL
   npx wrangler secret put FLEET_API_TOKEN
   ```
8. Only once the above is live: update
   `profiles/santa-config.mobileconfig` with the real `SyncBaseURL` and
   resolve the open design question above before actually pushing it -
   this changes real enforcement behavior on the real Mac, same
   "confirm before implementing" bar as everything else in this project.
