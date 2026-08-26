# Phase 1 - Fleet MDM on Fly.io (DECOMMISSIONED)

**This entire stack has been replaced.** Fleet was dropped in favor of
SimpleMDM (a hosted SaaS MDM) - see
`mac/docs/PHASE_1C_FLEET_TO_SIMPLEMDM_MIGRATION.md` for the full real
migration record. The Mac is enrolled in SimpleMDM now, not Fleet; the
Worker's `fleetClient.ts` is deleted; these four Fly.io apps are being
torn down per that doc's Phase 6. Two earlier plans to relocate
Fleet's *hosting* instead (`PHASE_1B_FLEET_ORACLE_MIGRATION.md`,
abandoned; `PHASE_1B_FLEET_HETZNER_MIGRATION.md`, superseded) both
became moot once dropping Fleet entirely turned out cheaper and
simpler than relocating it.

Kept below, unedited, purely as a record of what this stack was and
how it worked - not a runbook to follow or a live setup to maintain.

Four small Fly.io apps, all in the same region so they share a private
network: `contentguard-fleet-mysql`, `contentguard-fleet-redis`,
`contentguard-fleet` (the server itself), and `contentguard-fleet-tunnel`
(cloudflared). Only the tunnel app ever talks to the public internet - the
other three have no `[[services]]` block at all, so there's nothing to
attack even if you wanted to.

Run everything below from wherever you're running `flyctl`/`wrangler`
(your Codespace, per the Phase 0 decision) - none of it needs to happen on
the Mac itself except the very end (installing the enrollment profile).

## 1.1 Deploy Fleet, MySQL, Redis

```bash
fly auth login   # if you haven't already
```

**MySQL first** (Fleet can't start without it):

```bash
fly apps create contentguard-fleet-mysql
fly volumes create fleet_mysql_data --app contentguard-fleet-mysql --region iad --size 10
fly secrets set --app contentguard-fleet-mysql \
  MYSQL_ROOT_PASSWORD="$(openssl rand -hex 24)" \
  MYSQL_DATABASE=fleet \
  MYSQL_USER=fleet \
  MYSQL_PASSWORD="$(openssl rand -hex 24)"
```

Note down what `openssl rand` generated - `fly secrets set` doesn't echo
values back, and you need the exact `MYSQL_PASSWORD` value again in a
minute for Fleet's own secrets. Easiest: run each `openssl rand -hex 24`
separately first, save the outputs to your scratch note, then paste them
into the `fly secrets set` commands.

```bash
fly deploy --app contentguard-fleet-mysql --config mac/fleet/mysql/fly.toml
```

**Redis next:**

```bash
fly apps create contentguard-fleet-redis
fly volumes create fleet_redis_data --app contentguard-fleet-redis --region iad --size 1
fly secrets set --app contentguard-fleet-redis REDIS_PASSWORD="$(openssl rand -hex 24)"
fly deploy --app contentguard-fleet-redis --config mac/fleet/redis/fly.toml
```

Again, save that `REDIS_PASSWORD` value.

**Fleet itself:**

```bash
fly apps create contentguard-fleet
fly secrets set --app contentguard-fleet \
  FLEET_MYSQL_PASSWORD="<the MYSQL_PASSWORD value from above>" \
  FLEET_REDIS_PASSWORD="<the REDIS_PASSWORD value from above>" \
  FLEET_SERVER_PRIVATE_KEY="$(openssl rand -hex 32)"
fly deploy --app contentguard-fleet --config mac/fleet/fleet/fly.toml
```

Save `FLEET_SERVER_PRIVATE_KEY` too - Fleet uses it to encrypt sensitive
data at rest (including the APNs certificate's private key once you
upload it in step 1.2). If you lose it after that point, you're redoing
1.2 from scratch with Apple. Good candidate for the Phase 5 vault.

Sanity check everything's actually running:

```bash
fly status --app contentguard-fleet-mysql
fly status --app contentguard-fleet-redis
fly status --app contentguard-fleet
fly logs --app contentguard-fleet   # watch for "fleet prepare db" succeeding, then the server starting
```

## Set up the Cloudflare Tunnel

1. In the Cloudflare Zero Trust dashboard: **Networks > Tunnels > Create a
   tunnel > Cloudflared**.
2. Name it something like `contentguard-fleet`.
3. It gives you a connector token (a long string, part of a `cloudflared
   tunnel run --token ...` command) - copy just the token value.
4. **Public Hostname** tab: add a hostname, e.g. `fleet.yourdomain.com`
   (needs to be a domain already on your Cloudflare account), pointing at
   service type **HTTP**, URL `contentguard-fleet.internal:8080` - that's
   Fleet's private Fly address, reachable because the tunnel app shares
   the same Fly private network.

Deploy the tunnel app:

```bash
fly apps create contentguard-fleet-tunnel
fly secrets set --app contentguard-fleet-tunnel TUNNEL_TOKEN="<the connector token from the dashboard>"
fly deploy --app contentguard-fleet-tunnel --config mac/fleet/tunnel/fly.toml
```

Back in the Cloudflare dashboard, the tunnel should flip to **Healthy**
within a minute or two. Once it does, `https://fleet.yourdomain.com`
should load Fleet's setup wizard in a browser.

## 1.2 - 1.6

Everything from here (APNs cert, enrolling the Mac, pushing the profiles
in `profiles/`, Recovery Lock, the six verification tests, locking WARP)
is interactive - walk through it in conversation rather than a script,
since each step depends on what the previous one actually showed. See the
top-level build prompt for the full step list; the profiles referenced
there live in `profiles/` at the repo root.
