# Cloudflare Worker + dashboard setup (Phase 4)

Scope and the three design decisions behind it (ratchet mechanics,
dashboard auth, Santa+Fleet-only for now) are already made and
documented in `mac/README.md`'s Phase 4 row - not revisited here. This
doc tracks what's actually been built and verified versus what's still
ahead, the same way `PHASE_3_SANTA_SETUP.md` did for Santa.

**Dashboard auth changed mid-Phase 4.** The original plan was to sit the
dashboard behind the existing Cloudflare Zero Trust instance from Phase
1. That was fully built and verified (see this doc's git history), then
abandoned once it turned out what actually gates that Zero Trust
instance day-to-day is a **Device Profile** setting (Team & Resources ->
Devices -> Device Profiles), not an Access Policy - a different Zero
Trust primitive that an Access Application can't reference. Rather than
build a parallel IP-range Access Policy to replicate the "only
changeable from the office" constraint, the dashboard now has its own
password gate, deliberately modeled on the same proven pattern already
in use in the sibling ContentGuard Android app: a password re-entered to
log in, a "change password" flow that goes through the identical 24h
ratchet as every other loosening action, and the same real office
password reused for both (the user's explicit, informed choice - see
"Dashboard password auth" below for the one real tradeoff this accepts
and how it's mitigated). `src/cloudflareAccess.ts` and the Access
Application setup that was in progress for it have both been removed/
abandoned.

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

## Real Cloudflare deployment, and a real gap it found

Santa sync, the ratchet mechanism, and Fleet integration above were
actually deployed to a real Cloudflare account (D1 database created and
migrated, Worker deployed to a `workers.dev` subdomain, Cron Trigger
registered) before this auth rewrite started, and re-verified live
against that real deployment, not just locally.

That real deployment surfaced a genuine, previously-missed gap:
`preflight`/`eventupload`/`ruledownload`/`postflight` had **no
authentication at all** - a mistake this sandbox couldn't have caught on
its own, since it never had a public endpoint to probe. Confirmed live:
anyone could `POST /preflight/{any-id}` and get a real response,
creating device rows; far worse, `/ruledownload` would have handed out
this project's entire denylist to anyone who asked. Fixed using Santa's
own real, documented `SyncExtraHeaders` mechanism (confirmed via
northpole.dev, not guessed): a static shared token
(`X-ContentGuard-Sync-Token` header) checked by `auth.ts`'s
`requireSyncToken` against a new `SANTA_SYNC_TOKEN` secret, fails closed
(503) when unset. Verified against the real deployment: wrong/missing
token 401s, correct token works exactly as before, and the probe data
created while the gap was open was cleaned up afterward.
`profiles/santa-config.mobileconfig` will need a matching
`SyncExtraHeaders` entry once `SyncBaseURL` is actually wired up - a
separate, deliberate step, not done yet.

This dashboard-password-auth rewrite has **not** been deployed to that
real Cloudflare account yet - it's been verified locally only (see
above). Redeploying it, including the new D1 migration and bootstrapping
the real password hash, is the next real infra step (below).

## Also real and verified: dashboard password auth

Replaces Cloudflare Access entirely (see this doc's intro for why). A
single password gates the whole dashboard, stored as a SHA-256 hash in
D1's `dashboard_auth` table (`worker/schema.sql`) - never as a Wrangler
secret, since it now goes through its own 24h ratchet exactly like a
Santa rule loosen, and D1 is where every other piece of mutable state
already lives.

- `POST /api/login` - checks a login-lockout window first (`db.ts`'s
  `isLoginLockedOut`: 5 failures / 15 minutes, mitigating the one real
  tradeoff this design accepts - no more edge-level brute-force blocking
  now that Cloudflare Access's own login is out of the picture), then
  the password itself. On success, sets a stateless HMAC-signed session
  cookie (`worker/src/session.ts`, `SESSION_SIGNING_KEY`, 24h expiry,
  `HttpOnly`/`Secure`/`SameSite=Strict`) - no sessions table, nothing to
  clean up.
- `POST /api/logout` - clears the cookie.
- `requireSession` (`worker/src/auth.ts`) gates every `/api/rules...`,
  `/api/loosen-requests...`, `/api/software...`, and
  `/api/password/...` route. `GET /` itself is never hard-blocked -
  `index.ts` renders `renderLoginPage()` or `renderDashboard()` directly
  depending on whether the request already carries a valid session,
  matching the Android sibling app's pattern this design is modeled on.
- **Changing the password** goes through the identical ratchet as
  loosening a Santa rule (`worker/src/ratchet.ts`'s
  `requestPasswordChange`/`applyDuePasswordChanges`, `db.ts`'s
  `pending_password_changes` table): requires the current password,
  queues the new hash with `applies_at` 24h out, cancellable before then,
  applied by the same Cron-triggered `scheduled` handler that applies due
  rule loosens. Deliberately the *same* stored password for both general
  login and the loosen-request re-check (`handleLoosenRequest` in
  `index.ts`) - not two independently-configured secrets that could
  drift apart, per the user's explicit choice.

**Verified against a real local `wrangler dev` instance**, same bar as
the ratchet mechanism above: `GET /` with no session shows the login
page, with a valid session shows the real dashboard; every `/api/...`
route 401s with no session and 200s with one; wrong password 401s,
correct password 200s with a `Set-Cookie` that then authenticates
subsequent requests; 5 failed logins correctly 429 a 6th attempt *before*
even checking the password; the password-change flow end-to-end - wrong
current-password 403s, correct-password 202s and queues a
`pending_password_changes` row, a duplicate request 409s, `GET
/api/password/pending-change` shows it, cancelling clears it, and
(forcing `applies_at` into the past and triggering the scheduled handler
via `wrangler dev`'s real `/__scheduled` test endpoint, not simulated)
the new password actually takes over - the old one 401s, the new one
logs in - and a rule's loosen-request re-check correctly accepts that
same new password afterward, confirming the two really do share one
hash. Sync-protocol and rule-tighten/loosen routes re-verified unchanged
after this rewiring.

## Also real and verified: the dashboard itself

`worker/src/dashboard.ts` - a single-page HTML+vanilla-JS dashboard
(no build step, no external CDN dependency), served at `GET /` by the
Worker itself (`renderLoginPage()` or `renderDashboard()` depending on
session validity - see "dashboard password auth" above). Three sections
matching the "single control panel" scope plus the password gate itself:
Santa rules (list, add, request-loosen with a password prompt, cancel a
pending loosen, a live countdown to when a queued loosen applies), Fleet
software (list, upload, install on a host), and change password (current/
new password form, a pending-change note with its own countdown and
cancel button, mirroring the rules section's pending-loosen display).

One small backend addition the dashboard needed: `GET /api/loosen-requests`,
listing every loosen request still in flight - `db.ts`'s
`listActiveLoosenRequests`.

**Verified against a real headless Chromium browser** for the original
Cloudflare-Access-era build (both tables rendering correctly, all five
interactive actions firing the right HTTP request), and against a real
`wrangler dev` instance via curl for the password-auth rewrite (see
above) - the login page renders and posts to `/api/login` correctly, the
real dashboard renders once a session cookie is set, and the new change-
password section's three actions (request, view pending, cancel) were
exercised through the same live-instance verification as the rest of the
password auth work.

**Phase 4's original scope is now fully built and verified** - Santa
sync, ratchet, Fleet API, dashboard password auth, and the dashboard
itself. The password-auth rewrite has since been deployed for real too
and the dashboard confirmed live and working (login, session, ratchet,
all against the actual Cloudflare account).

## Real end-to-end confirmation: Santa actually syncing against the live Worker

Once `profiles/santa-config.mobileconfig`'s `SyncBaseURL`/`SyncExtraHeaders`
were pushed through Fleet (see setup steps below) and the token rotated
one final time (the value used to verify the sync-token fix earlier had
appeared in more than one AI session transcript through debugging - not
kept as the value this profile ships with long-term), `sudo santactl sync
--debug` on the real Mac surfaced two more real, previously-invisible
gaps - found only because this was the first time the real Santa client
(not curl, not `wrangler dev`) ever actually hit this Worker:

1. **Cloudflare Gateway (Phase 1's WARP setup on this same Mac) was
   blocking the connection outright** - a firewall policy needed adding
   to explicitly allow this specific Worker's hostname. First attempt
   used a `*.workers.dev` wildcard, which was too broad (that subdomain
   is shared by every Cloudflare Workers deployment on every account,
   not just this one) and got narrowed to the exact hostname before
   saving, matching this project's "narrow, deliberate allowances only"
   bar already established for the DoH-provider blocklist and Tor
   Browser block.
2. **A real code bug in every sync handler**: Santa's own
   `SyncClientContentEncoding` config key defaults to `deflate` -
   confirmed directly in `northpolesec/santa`'s own
   `docs/src/lib/santaconfig.ts`, not guessed - meaning every real sync
   request Santa sends is deflate-compressed by default. Cloudflare
   Workers' `Request` object does not auto-decompress an incoming body
   based on `Content-Encoding`, so `worker/src/santaSync.ts`'s
   `request.json()` calls were parsing raw compressed bytes as JSON,
   throwing, and `index.ts`'s catch-all turned that into an opaque 500
   "Internal Server Error" - exactly what `santactl sync --debug`
   reported once the Gateway block above was cleared. This was invisible
   to every prior test in this project's history (curl, `wrangler dev`)
   since none of them compress request bodies by default. Fixed with a
   shared `parseJsonBody()` helper that decompresses via the Web
   Compression Streams API (`DecompressionStream`) when `Content-Encoding`
   is `deflate` or `gzip`, applied to all four sync stage handlers.
   Verified locally first against real zlib-compressed bodies (matching
   HTTP's `deflate` semantics exactly, not `deflate-raw`) before
   redeploying.

**Confirmed live on the real Mac after both fixes**: `sudo santactl sync
--debug` completed the full four-stage cycle -
preflight/eventupload/ruledownload/postflight - ending in "Sync completed
successfully", with `ruledownload` correctly returning zero rules (the
Worker's `rules` table is genuinely empty right now - StaticRules is
still the entire enforcement layer, exactly as designed; see "StaticRules
vs. sync" below). Phase 4 is now fully built, deployed, and verified
end-to-end for real - nothing left in this phase's original scope.

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

## Real infra setup steps

**Steps 1-6, 8, and 9 are all done for real now** - the D1 database, the
original Worker deploy, and this auth rewrite's migration/secret/password-
bootstrap/redeploy have all been run against the real Cloudflare account
(by the collaborating Codespace session) and verified live, not just
locally: `GET /` on the real deployed URL shows the login page, logging in
with the real password sets a working session cookie, `/api/rules` 401s
without one and 200s with one, and a wrong-password attempt correctly
401s. Dashboard is live at
`https://contentguard-worker.yl1nbjaww6741-4.workers.dev`.
`wrangler.toml`'s two placeholders (`__CLOUDFLARE_ACCOUNT_ID__`,
`__D1_DATABASE_ID__`) are filled in on the real deployed machine as a
result of this; they're kept as placeholders in this repo deliberately,
same pattern as every other real-value placeholder here.

**Real security follow-up, not a code bug**: the Cloudflare API token used
to run those commands ended up written into that session's own transcript
in full - roll it at `dash.cloudflare.com/profile/api-tokens` if that
hasn't already been done. Nothing above depends on the old value once
rolled.

**Steps 7 (`SANTA_SYNC_TOKEN` only) and 11 are now also done for real**,
with real end-to-end confirmation - see "Real end-to-end confirmation"
above for the two genuine bugs (a Gateway DNS block, a request-
decompression gap) this surfaced along the way. `FLEET_BASE_URL`/
`FLEET_API_TOKEN` remain unset - fine to leave for now, the Fleet
software-deployment half of the dashboard just stays inert until they're
set, everything else is unaffected. Step 10's Access Application cleanup
in the Zero Trust dashboard is still just manual housekeeping, never
blocking anything.

1. `cd worker && npx wrangler login` (authenticates the CLI to your real
   Cloudflare account).
2. `npx wrangler d1 create contentguard` - creates the real D1 database
   and prints its ID. Fill that into `wrangler.toml`'s
   `__D1_DATABASE_ID__`.
3. Fill in `__CLOUDFLARE_ACCOUNT_ID__` (visible in the Cloudflare
   dashboard's sidebar, or `wrangler whoami`).
4. `npm run db:migrate:remote` - applies `schema.sql` to the real,
   remote D1 database (mirrors the local verification already done
   above). Already run once for the original tables; running it again
   is a no-op for those (`CREATE TABLE` without `IF NOT EXISTS` will
   error on tables that already exist, which is why step 6 below uses a
   separate incremental migration file instead of re-running the whole
   schema).
5. `npm run deploy` - deploys to the `workers.dev` subdomain.
6. `npx wrangler d1 execute contentguard --remote --file=./migrations/0002_dashboard_auth.sql` -
   adds this auth rewrite's three new tables (`dashboard_auth`,
   `pending_password_changes`, `failed_login_attempts`) to the
   already-deployed remote database without re-running the whole schema.
7. Set the secrets this rewrite needs (both fail closed if left unset -
   `SESSION_SIGNING_KEY` unset means no session can ever validate, so
   `GET /` just keeps showing the login page; `SANTA_SYNC_TOKEN` unset
   503s every sync request):
   ```bash
   # Any long random string - it's an internal HMAC key, not something
   # you type in, so there's no "remember this" constraint like the
   # dashboard password has.
   npx wrangler secret put SESSION_SIGNING_KEY
   npx wrangler secret put SANTA_SYNC_TOKEN
   # Fleet's own UI: "My account" -> "Get API token"
   npx wrangler secret put FLEET_BASE_URL
   npx wrangler secret put FLEET_API_TOKEN
   ```
8. Bootstrap the real dashboard password - deliberately a manual D1
   write, not a code path, so "no password set yet" can never mean
   "anyone can set one" (see `db.ts`'s `getDashboardPasswordHash` doc
   comment):
   ```bash
   # On macOS: echo -n 'your real password' | shasum -a 256
   # (the same real office password from Team & Resources -> Devices ->
   # Device Profiles, per the user's explicit choice - see this doc's
   # intro for why.)
   npx wrangler d1 execute contentguard --remote --command \
     "INSERT INTO dashboard_auth (id, password_hash, updated_at) VALUES (1, '<hash>', <unix_ms_now>)"
   ```
9. Redeploy (`npm run deploy`) so the new routes/secrets take effect,
   then confirm `GET /` on the real `workers.dev` URL shows the login
   page and logs in with the real password before considering this done.
10. Abandon the in-progress Cloudflare Access Application setup in the
    Zero Trust dashboard - no longer needed.
11. **Done.** `profiles/santa-config.mobileconfig` has the real
    `SyncBaseURL` (`https://contentguard-worker.yl1nbjaww6741-4.workers.dev/`,
    trailing slash matters - confirmed via `northpolesec/santa`'s own real
    source, not its docs website, which came back empty on every fetch
    attempt) and a `SyncExtraHeaders` entry, `PayloadVersion` bumped to 3
    on both the top-level and payload dicts (same `PayloadUUID`s, so this
    updated the already-installed profile rather than registering a new
    one). The token was rotated once before this went live - the value
    first used to verify the sync-token fix end-to-end had appeared in
    plaintext across more than one AI session transcript during
    debugging, so it was replaced rather than kept long-term; the
    Worker's `SANTA_SYNC_TOKEN` secret matches the final value. Pushed
    through Fleet and confirmed on the real Mac: `sudo santactl sync
    --debug` completes the full four-stage cycle and ends in "Sync
    completed successfully."

    Getting here also required two real fixes neither `wrangler dev` nor
    curl-based testing ever caught, only found once a real Santa client
    hit this Worker for the first time - see "Real end-to-end
    confirmation" above: a Cloudflare Gateway policy on the Mac was
    blocking the connection outright (fixed with a narrowly-scoped
    firewall allow rule, not a wildcard), and every sync handler crashed
    on Santa's default deflate-compressed request bodies (fixed with a
    decompression step, `worker/src/santaSync.ts`'s `parseJsonBody()`).
