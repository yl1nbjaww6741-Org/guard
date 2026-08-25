# Phase 1b - Migrate Fleet MDM from Fly.io to Oracle Cloud Always Free (ABANDONED)

**Superseded by `PHASE_1B_FLEET_HETZNER_MIGRATION.md` - this whole
approach is blocked, not just expensive.** Real, verified finding while
staging this migration live: `fleetdm/fleet` is published **amd64-only**
(confirmed three ways - `docker image inspect`, an actual `exec format
error` running it, and Docker Hub's API showing no arm64 tag exists at
all) - Oracle's Always Free tier is **Ampere A1, which is ARM**. The
free-ARM-capacity premise this whole document was built on doesn't hold
for the one piece that matters most. A paid x86 Oracle shape sized to
fit (2 OCPU/8GB) quoted **$72/month** in the real Console - worse than
the ~$17/month Fly.io bill this was trying to beat, not better. See
`PHASE_1B_FLEET_HETZNER_MIGRATION.md` for the real path forward (a
genuinely x86 provider, at real prices well below both).

Real work product from this attempt that carried forward, not wasted:
the corrected `docker-compose.yml` shape, the `FLEET_SERVER_PRIVATE_KEY`/
`FLEET_LICENSE_KEY`/image-pinning/restore-then-prepare fixes, the real
exported MySQL dump (verified, 222/222 objects, md5 confirmed) and
secrets, and the tunnel-token-reuse plan - all reused directly in the
Hetzner doc rather than redone.

Kept here, unedited below, purely as a record of what was tried and
why it stopped - not a runbook to follow.

---

**Hands-on-infrastructure runbook, same shape as `PHASE_0_SETUP.md` and
`PHASE_5_LOCKDOWN.md` - nothing here is executable from a sandboxed
session with no SSH access to Oracle, no SSH/API access to the Fly.io
instance, and no Oracle credentials. Run this yourself, on a real
terminal.**

## What's actually moving

Real current state, confirmed against `mac/fleet/`'s four real
`fly.toml` files and `mac/fleet/README.md` - not the generic plan this
doc started from:

| App (real name) | What it is | Public? |
|---|---|---|
| `contentguard-fleet-mysql` | Fleet's MySQL 8.0 backend | No - `contentguard-fleet-mysql.internal:3306` only |
| `contentguard-fleet-redis` | Fleet's Redis cache (live queries, sessions), password-protected | No - `contentguard-fleet-redis.internal:6379` only |
| `contentguard-fleet` | Fleet itself | No - `contentguard-fleet.internal:8080` only |
| `contentguard-fleet-tunnel` | cloudflared | The only outbound-internet piece of the whole stack |

All four in Fly's `iad` region, same private 6PN network. Nothing else
in this repo runs on Fly.io - a service called "COMMAND" was mentioned
in the original migration prompt this doc is based on; confirmed with
the user it belongs to a different, unrelated repo and needs no special
handling here.

## Two real problems in the original plan, fixed below

Checked the generic migration plan against what's actually deployed and
found two gaps that would cause silent, hard-to-diagnose breakage
rather than a clean failure:

1. **`FLEET_SERVER_PRIVATE_KEY` was never carried over.** This
   deployment doesn't store the APNs certificate as mounted PEM files -
   it's uploaded once through Fleet's own setup wizard and stored
   **encrypted in MySQL**, using this exact key (`mac/fleet/fleet/fly.toml`'s
   own comment: "Fleet uses this to encrypt sensitive data at rest -
   e.g. the APNs cert private key once you upload it"). Import the
   MySQL dump onto Oracle under a *different* `FLEET_SERVER_PRIVATE_KEY`
   and Fleet has the encrypted cert but can't read it - MDM push breaks,
   with no error at deploy time. This needs the identical "copy the
   exact value, never regenerate" treatment the original plan already
   gives the APNs cert itself (Phase 3 below).
2. **No `fleet prepare db` step in the Oracle compose file.** On Fly,
   `[deploy].release_command = "fleet prepare db --no-prompt"` runs
   schema migrations before every deploy, automatically. The generic
   plan's `docker-compose.yml` has no equivalent - a fresh Fleet
   container against the imported dump may not apply schema correctly
   without it (Phase 4 below).

A third, smaller thing worth doing differently: the original plan has
you *create a new Cloudflare Tunnel* on Oracle and point DNS at it. Fleet's
real Public Hostname binding lives in Cloudflare's config, not tied to
which machine runs `cloudflared` - **reusing the exact same
`TUNNEL_TOKEN`** already in `contentguard-fleet-tunnel`'s Fly secrets on
the Oracle instance means the hostname never changes at all, so the Mac
never needs re-enrollment (Phase 5's "Option B" in the original plan
becomes unreachable - it can't happen if the token, and therefore the
tunnel identity, never changes).

## Prerequisites

- [ ] Oracle Cloud account created (Always Free tier)
- [ ] Home region selected - **note**: Always Free's Ampere A1 (ARM)
      capacity is well known to be oversubscribed in popular regions;
      provisioning can hang or fail with "out of capacity" and need
      retrying at a different time or region. Not something to fix here,
      just don't be surprised by it.
- [ ] A domain on Cloudflare with DNS managed there (already true - this
      is the same Cloudflare account/zone `panel.lukep009.download` and
      Fleet's own tunnel hostname already live on)
- [ ] `contentguard-fleet`, `-mysql`, `-redis`, `-tunnel` all currently
      healthy on Fly (`fly status --app <name>` for each)
- [ ] The Mac is enrolled and MDM profiles are applied (already true per
      Phase 1's own closed status in `mac/README.md`)

## Phase 1 - Provision the Oracle instance

Same as the original plan - Compute -> Instances -> Create Instance,
**Ampere A1 Flex** shape (the Always Free ARM one), 2 OCPU / 12GB RAM /
100GB boot volume, a VCN with a public subnet and public IP, your SSH
key. Security list: **only port 22 inbound** - matches this stack's own
existing "nothing public except the tunnel" design exactly, nothing to
change about that philosophy.

## Phase 2 - Set up the Oracle instance

```bash
ssh -i ~/.ssh/your_key opc@<oracle-instance-public-ip>   # 'ubuntu' user if you picked Ubuntu instead
```

Docker + Compose (Oracle Linux 8):

```bash
sudo dnf install -y dnf-utils
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out and back in after this
```

(Ubuntu: `sudo apt update && sudo apt install -y docker.io docker-compose-v2`, same enable/usermod steps.)

cloudflared (ARM64 - Oracle's Ampere A1 is genuinely ARM, this matters):

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

No `cloudflared tunnel login`/`cloudflared tunnel create` needed - Phase 5
below reuses the existing tunnel via its token instead of creating a new one.

## Phase 3 - Export everything from Fly.io (don't shut anything down yet)

**Gather the real secrets first** - these are the exact values this
deployment actually uses, not generic placeholders:

```bash
fly secrets list --app contentguard-fleet-mysql   # MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD (names only - fly doesn't echo values)
fly secrets list --app contentguard-fleet-redis    # REDIS_PASSWORD
fly secrets list --app contentguard-fleet          # FLEET_MYSQL_PASSWORD, FLEET_REDIS_PASSWORD, FLEET_SERVER_PRIVATE_KEY
fly secrets list --app contentguard-fleet-tunnel   # TUNNEL_TOKEN
```

`fly secrets list` only confirms names exist, never values - if these
weren't saved somewhere durable when first generated (`mac/fleet/README.md`'s
own setup steps say to), there's no way to read them back out of Fly at
all. If any are genuinely lost, stop here - regenerating
`FLEET_SERVER_PRIVATE_KEY` specifically means the APNs cert becomes
permanently undecryptable and MDM push needs to be re-set-up with Apple
from scratch, exactly like losing the cert itself.

**Dump MySQL** (real app name, real database name):

```bash
fly proxy 3307:3306 -a contentguard-fleet-mysql
# in a second terminal:
mysqldump -h 127.0.0.1 -P 3307 -u fleet -p fleet > fleet-backup.sql
# password prompt: the real MYSQL_PASSWORD value from Phase 3's secrets step
```

**No separate APNs cert file to copy** - unlike the generic plan's
assumption, this deployment's APNs cert lives inside `fleet-backup.sql`
itself (encrypted with `FLEET_SERVER_PRIVATE_KEY`), not as standalone
PEM files anywhere on the Fly instance. The dump above already has it.

## Phase 4 - Deploy Fleet on Oracle

```bash
mkdir -p ~/fleet && cd ~/fleet
```

`docker-compose.yml` - corrected from the generic plan: real env var
names matching `contentguard-fleet/fly.toml` exactly, Redis actually
password-protected (the generic plan's Redis had none at all - a real
regression from what's live today), and no APNs PEM-file mount (not how
this deployment stores it):

```yaml
services:
  mysql:
    image: mysql:8.0
    platform: linux/arm64
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: fleet
      MYSQL_USER: fleet
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
    command: >
      --default-authentication-plugin=mysql_native_password
      --character-set-server=utf8mb4
      --collation-server=utf8mb4_unicode_ci

  redis:
    image: redis:7-alpine
    platform: linux/arm64
    restart: always
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes --dir /data
    volumes:
      - redis_data:/data

  fleet-prepare:
    image: fleetdm/fleet:latest
    platform: linux/arm64
    depends_on: [mysql, redis]
    environment:
      FLEET_MYSQL_ADDRESS: mysql:3306
      FLEET_MYSQL_DATABASE: fleet
      FLEET_MYSQL_USERNAME: fleet
      FLEET_MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    command: fleet prepare db --no-prompt
    restart: "no"

  fleet:
    image: fleetdm/fleet:latest
    platform: linux/arm64
    restart: always
    depends_on: [mysql, redis]
    environment:
      FLEET_MYSQL_ADDRESS: mysql:3306
      FLEET_MYSQL_DATABASE: fleet
      FLEET_MYSQL_USERNAME: fleet
      FLEET_MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      FLEET_REDIS_ADDRESS: redis:6379
      FLEET_REDIS_PASSWORD: ${REDIS_PASSWORD}
      FLEET_SERVER_PRIVATE_KEY: ${FLEET_SERVER_PRIVATE_KEY}
      FLEET_SERVER_ADDRESS: 0.0.0.0:8080
      FLEET_SERVER_TLS: "false"
      FLEET_LOGGING_JSON: "true"
    ports:
      - "127.0.0.1:8080:8080"   # localhost only - the tunnel handles external access, same as Fly

volumes:
  mysql_data:
  redis_data:
```

`.env` (same directory) - **paste the exact real values gathered in
Phase 3**, not new ones:

```bash
MYSQL_ROOT_PASSWORD=<real value from contentguard-fleet-mysql>
MYSQL_PASSWORD=<real value from contentguard-fleet-mysql>
REDIS_PASSWORD=<real value from contentguard-fleet-redis>
FLEET_SERVER_PRIVATE_KEY=<real value from contentguard-fleet - MUST match exactly, or the APNs cert becomes unreadable>
```

Bring up MySQL/Redis first, run migrations once, then start Fleet:

```bash
docker compose up -d mysql redis
sleep 15   # let MySQL finish initializing before migrations touch it
docker compose run --rm fleet-prepare
docker compose exec -T mysql mysql -u fleet -p"$MYSQL_PASSWORD" fleet < ~/fleet/fleet-backup.sql
docker compose up -d fleet
docker compose logs fleet   # watch for a clean startup, no decrypt/auth errors
curl http://localhost:8080/healthz   # should return OK
```

## Phase 5 - Point the existing tunnel at Oracle instead of Fly

No new tunnel, no DNS change - same tunnel identity, just run its
connector on Oracle instead:

```bash
cloudflared tunnel run --token "<the real TUNNEL_TOKEN value from Phase 3>"
```

Confirm it connects (Cloudflare Zero Trust dashboard -> Networks ->
Tunnels -> should show **Healthy**, sourced from the Oracle instance now)
before making it permanent:

```bash
sudo cloudflared service install --token "<the real TUNNEL_TOKEN value>"
sudo systemctl enable --now cloudflared
```

**Do not touch the tunnel's Public Hostname config in the Cloudflare
dashboard at all** - that's what makes this safe. The hostname keeps
pointing at the same tunnel; only which machine answers changed.

## Phase 6 - Verify before touching Fly at all

Since the tunnel identity never changed, this should be a non-event -
worth confirming for real anyway, not assumed:

- [ ] Fleet's UI at the real hostname shows the Mac as enrolled, recently checked in
- [ ] `sudo profiles list` on the Mac (or Fleet's own host detail page) shows every profile still applied
- [ ] Push a trivial change from Fleet's UI (e.g. edit a profile's own label) and confirm it lands
- [ ] APNs push works - trigger any real MDM command from Fleet and confirm the Mac responds
- [ ] `sudo santactl sync --debug` on the Mac still completes cleanly - Santa syncs through this
      project's own Cloudflare Worker (`panel.lukep009.download`), not Fleet directly, so this
      should be completely unaffected either way, but confirm rather than assume
- [ ] ContentGuard Central / the dashboard's Fleet-backed pages (`/central/`'s Fleet MDM and App
      control tabs, or the existing dashboard's own MDM lockdown section) still load real data -
      both call Fleet only indirectly, through this Worker's own `FLEET_BASE_URL`/`FLEET_API_TOKEN`
      secrets, which point at the tunnel hostname, not at Fly directly - should need no change,
      confirm rather than assume

## Phase 7 - Only once Phase 6 fully passes: shut down Fly

```bash
fly apps destroy contentguard-fleet
fly apps destroy contentguard-fleet-mysql
fly apps destroy contentguard-fleet-redis
fly apps destroy contentguard-fleet-tunnel
```

Keep `fleet-backup.sql` somewhere durable - not deleted, and not just on
the Oracle instance itself (see Phase 8).

## Phase 8 - Automated backups (Oracle Always Free has none built in)

```bash
cat > ~/fleet/backup.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=~/fleet/backups
mkdir -p "$BACKUP_DIR"
docker compose -f ~/fleet/docker-compose.yml exec -T mysql mysqldump -u fleet -p"$MYSQL_PASSWORD" fleet > "$BACKUP_DIR/fleet-$TIMESTAMP.sql"
find "$BACKUP_DIR" -name "*.sql" -mtime +7 -delete
SCRIPT
chmod +x ~/fleet/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * cd ~/fleet && MYSQL_PASSWORD=<real value> ./backup.sh >> ~/fleet/backups/backup.log 2>&1") | crontab -
```

Sync these off-instance too (Cloudflare R2 - this project already has a
bucket/credentials pattern for exactly this in `worker/wrangler.toml`'s
`EXTENSION_ASSETS` binding, though that's a separate bucket - a small
new one for Fleet backups is reasonable, not attempted here since it's
new scope beyond the migration itself).

## Phase 9 - Idle reclamation prevention

Oracle can reclaim an Always Free instance running sustained low CPU.
Same workaround as the original plan - not elegant, but documented as
necessary:

```bash
cat > ~/fleet/keepalive.sh << 'SCRIPT'
#!/bin/bash
dd if=/dev/urandom bs=1M count=10 2>/dev/null | md5sum > /dev/null
SCRIPT
chmod +x ~/fleet/keepalive.sh
(crontab -l 2>/dev/null; echo "*/10 * * * * ~/fleet/keepalive.sh") | crontab -
```

## Rollback

Fly.io stays untouched through Phase 6 - if anything looks wrong, just
run `cloudflared tunnel run --token "..."` back on the OLD Fly tunnel
app instead of Oracle (or simply don't run Phase 7's `fly apps destroy`
commands). Since the tunnel identity never changed, rollback is "point
the connector back," not "re-provision and re-enroll."

## What NOT to touch

- COMMAND (a different, unrelated repo - confirmed with the user, no
  special handling needed)
- The APNs certificate - never regenerate; same now applies to
  `FLEET_SERVER_PRIVATE_KEY` (see this doc's own "two real problems" section)
- MDM profiles on the Mac - persist regardless of where Fleet runs
- Cloudflare Gateway/WARP/DNS - unaffected, all Cloudflare-side
- `worker/`'s own `FLEET_BASE_URL`/`FLEET_API_TOKEN` secrets - point at
  the tunnel hostname, which doesn't change in this plan, so these
  shouldn't need updating; confirm in Phase 6 rather than assume
- Santa's `SyncBaseURL` (`profiles/santa-config.mobileconfig`) - already
  points at this project's own Worker, not Fleet, unaffected either way

## Post-migration checklist

- [ ] Oracle instance running, mysql/redis/fleet containers all healthy
- [ ] Tunnel showing Healthy in Cloudflare, sourced from Oracle
- [ ] Mac enrolled and checking in, all profiles still applied
- [ ] APNs push confirmed working with a real test command
- [ ] Automated daily MySQL backups running, synced off-instance
- [ ] Keepalive cron active
- [ ] Fly.io Fleet apps destroyed (all four)
- [ ] `fleet-backup.sql` kept somewhere durable, off the Oracle instance
