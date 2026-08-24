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

## Not built yet

- **Fleet API integration** for `.pkg` deployment from the dashboard -
  no code written yet. Fleet's REST API (the same one its own web UI
  uses) supports uploading software and targeting installs
  programmatically; this Worker doesn't call it yet.
- **Cloudflare Access auth** - not wired into the Worker at all yet. The
  plan (reuse the existing Zero Trust instance from Phase 1) is an
  infrastructure/configuration step done in Cloudflare's dashboard, not
  code - see setup steps below - plus a small amount of Worker code to
  verify the `Cf-Access-Jwt-Assertion` header as defense in depth rather
  than trusting Access alone (and, once that's real, to retire the
  interim `API_TOKEN` stopgap or keep both as layered defense - not yet
  decided).
- **The dashboard itself** - no frontend exists yet. Everything above is
  backend only.

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
5. Set the two secrets `worker/src/auth.ts` needs (both fail closed if
   left unset, so this can happen any time before real use, not
   necessarily before first deploy):
   ```bash
   npx wrangler secret put API_TOKEN
   # LOOSEN_PASSWORD_HASH must be a SHA-256 hex digest, not the raw
   # password - e.g. on macOS: echo -n 'your real password' | shasum -a 256
   npx wrangler secret put LOOSEN_PASSWORD_HASH
   ```
6. `npm run deploy` - first real deploy, to a `workers.dev` subdomain by
   default.
7. In Cloudflare's Zero Trust dashboard, create an Access Application
   pointing at that Worker's route, using the same Access policy already
   locked down in Phase 1.
8. Only once the above is live: update
   `profiles/santa-config.mobileconfig` with the real `SyncBaseURL` and
   resolve the open design question above before actually pushing it -
   this changes real enforcement behavior on the real Mac, same
   "confirm before implementing" bar as everything else in this project.
