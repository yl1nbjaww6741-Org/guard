# ContentGuard Central - web dashboard

A second, redesigned frontend for the same real Worker `worker/`
already serves (`panel.lukep009.download`) - Wise-light visual design
per `reference/DASHBOARD-PROMPT.md`/`reference/ContentGuardCentral.jsx`
(the original spec and prototype this was built from, kept for
traceability - see that directory), wired to the **existing,
already-deployed API**, not a new one.

## Scope of this pass - UI only

Explicit instruction this was built under: *"Only adjust the UI - don't
make any changes to connectors or anything else... everything has
already been connected up on the backend... our existing work trumps
the new code and prompt."* Concretely, that meant:

- **No new Worker endpoints, no Durable Object, no Cloudflare Access,
  no UniFi/WARP/Gateway API integration** - `worker/` is untouched by
  this directory entirely.
- Every page here calls a route that already exists and already works
  in `worker/src/index.ts` - see `src/lib/api.ts`, which is a 1:1 typed
  wrapper around those real routes, not `DASHBOARD-PROMPT.md`'s
  aspirational generic contract (`/api/state`, `/api/strengthen`,
  `/api/weaken`, a Durable Object-backed timer) - that contract doesn't
  exist server-side, and wasn't built to match it.
- **Nav is 6 pages, not the original spec's 17** - Home, Fleet MDM, App
  control (Santa), Restrictions (safe apps), Chrome policy, Change
  password. The other 11 (WARP, Gateway policies, Bypass prevention,
  UniFi, AI blocker telemetry, Boot security, Permissions, both Android
  pages, Audit log) have no matching endpoint anywhere in this Worker -
  explicit choice (asked directly) to leave them out of this pass
  entirely rather than build them against fabricated numbers.

## Real vs. prototype data shapes

`src/lib/types.ts`'s comment explains this in full: types here model
the Worker's actual response shapes (read directly out of
`worker/src/dashboard.ts`'s own working fetch/render code), not the
prototype's simplified mock data or the new prompt's idealized contract.
Two real differences from the prototype worth knowing before touching
this code:

- **Santa "app control" isn't a single allowed/blocked toggle list** -
  it's three real, differently-shaped things: permanent static rules
  (`santa-config.mobileconfig`, read-only here), dashboard-added dynamic
  rules (block/allow, loosen-request to un-block), and Fleet's installed-
  app inventory (Block/Allow both create a rule immediately - see
  `src/pages/Santa.tsx`'s own comment for why that's correct ratchet
  behavior, not an oversight).
- **MDM restrictions (Chrome policy, most of "Restrictions") aren't
  independently toggleable** - there's no per-bullet API, only a whole-
  `.mobileconfig`-file replace through the same 24h ratchet
  (`PATCH /api/config-profiles/:uuid`). `MdmProfileCard` shows the real
  restriction list as read-only text plus a real file-upload form, not
  invented per-row buttons.

## Auth

Same session-cookie model as the existing dashboard
(`credentials: "include"`, `POST /api/login`/`/api/logout`) - not
Cloudflare Access, matching this project's own history of trying and
dropping Access already (`schema.sql`'s `dashboard_auth` comment). Two
passwords, matching this session's own split: the login password gets
you in, the office password gates every loosening action (the vault
sheet).

**Real deployment blocker, not yet resolved**: if this ends up hosted
on Cloudflare Pages as `DASHBOARD-PROMPT.md` describes - a different
origin than the Worker (`panel.lukep009.download`) - cross-origin
cookie auth needs the Worker to send `Access-Control-Allow-Origin: <the
Pages origin>` (not `*` - credentialed requests reject a wildcard) and
`Access-Control-Allow-Credentials: true` on every response, handle
`OPTIONS` preflights, and the session cookie needs `SameSite=None;
Secure` rather than whatever it's set to now. None of that exists in
`worker/` today, and adding it is itself a connector change - out of
scope for this pass, flagged rather than silently worked around.
Simplest fix that avoids touching the Worker at all: serve this app's
built `dist/` from the same origin as the Worker instead of a separate
Pages project (e.g. Workers Assets/Sites, or a Pages project on a
subpath Cloudflare treats as the same site) - same-origin means no CORS
problem exists in the first place.

## Local dev

```bash
npm install
npm run dev        # Vite dev server - proxies nothing, so it needs
                    # something running the real Worker locally too
                    # (wrangler dev, from worker/) for the API calls to
                    # resolve, same as this repo's existing local-dev story
npm run typecheck
npm run build       # tsc --noEmit && vite build -> dist/
```

## Deployment - actually resolved, not the plan above anymore

Live at **https://panel.lukep009.download/central/**, confirmed via a
real `curl` (200, correct HTML/JS) - not the separate-Pages-project plan
this file originally laid out. Instead: `npm run build` outputs to
`dist/central/` (see `vite.config.ts`'s own comment), and
`worker/wrangler.toml`'s `[assets]` binding serves that same directory's
parent (`../web/dist`) as static files alongside the existing Worker -
no separate origin, so the CORS/cookie gap above never comes up at all.
`web/dist/` is committed (see `web/.gitignore`'s own comment) since this
repo's CI only ever deploys `worker/`, never builds `web/` - **rebuild
and re-commit `dist/` by hand whenever `web/`'s source changes**, or the
live site silently keeps serving old code.

```bash
npm run build          # -> dist/central/
cd ../worker && npx wrangler deploy --dry-run   # sanity-check first
git add -f web/dist && git commit && git push   # -f: dist/ is gitignore'd by default, deliberately overridden
```

## PWA icons (for the OTHER dashboard, not this one)

`reference/gen_icons.py` generates the icon set actually used by
`panel.lukep009.download`'s existing (non-React) dashboard's own PWA
manifest (`worker/src/dashboard.ts`'s `PWA_HEAD_TAGS`,
`web/dist/manifest.webmanifest`) - a shield mark in this app's own
Wise-light tokens (`bright`/`forest`), written straight to
`dist/icons/` since that's the real serving location. Re-run
(`python3 reference/gen_icons.py`, needs Pillow: `pip install Pillow`)
and re-commit if the mark itself ever needs to change - not generated
at build/deploy time, same hand-kept pattern as `dist/` itself.
