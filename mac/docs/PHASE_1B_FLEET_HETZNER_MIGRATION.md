# Phase 1b - Migrate Fleet MDM from Fly.io to Hetzner

**Hands-on-infrastructure runbook, same shape as `PHASE_0_SETUP.md` and
`PHASE_5_LOCKDOWN.md` - nothing here is executable from a sandboxed
session with no SSH access to Hetzner, no SSH/API access to the Fly.io
instance, and no Hetzner credentials. Run this yourself, on a real
terminal.**

## Why Hetzner, not Oracle

`PHASE_1B_FLEET_ORACLE_MIGRATION.md` (kept, marked abandoned) tried
Oracle Cloud's Always Free tier first. It's genuinely blocked, not just
worse: Oracle's free tier is **Ampere A1, which is ARM**, and
`fleetdm/fleet` is published **amd64-only** - confirmed three real ways
while staging that migration (`docker image inspect`, an actual `exec
format error` running it, Docker Hub's API showing no arm64 tag exists
at all). A paid x86 Oracle shape sized to fit quoted **$72/month** in
the real Console - worse than the ~$17/month Fly.io bill this is trying
to beat. Hetzner's cheap tiers (CX22: 2 vCPU/4GB/40GB) are **genuinely
x86_64** - no architecture blocker - at real prices well below both:
~€4.35/month (~$7.10 AUD at the time this was checked), confirmed
against Hetzner's own published pricing page, not guessed.

Everything non-architecture-specific from the Oracle attempt carries
forward unchanged below: the corrected `docker-compose.yml` shape, the
`FLEET_SERVER_PRIVATE_KEY`/`FLEET_LICENSE_KEY`/image-pinning/restore-
then-prepare fixes, and the tunnel-token-reuse plan.

## What's actually moving

Real current state, confirmed against `mac/fleet/`'s four real
`fly.toml` files and `mac/fleet/README.md` - not a generic plan:

| App (real name) | What it is | Public? |
|---|---|---|
| `contentguard-fleet-mysql` | Fleet's MySQL 8.0 backend | No - `contentguard-fleet-mysql.internal:3306` only |
| `contentguard-fleet-redis` | Fleet's Redis cache (live queries, sessions), password-protected | No - `contentguard-fleet-redis.internal:6379` only |
| `contentguard-fleet` | Fleet itself | No - `contentguard-fleet.internal:8080` only |
| `contentguard-fleet-tunnel` | cloudflared | The only outbound-internet piece of the whole stack |

All four in Fly's `iad` region, same private 6PN network. Nothing else
in this repo runs on Fly.io - a service called "COMMAND" was mentioned
in the original migration prompt this whole effort started from;
confirmed with the user it belongs to a different, unrelated repo and
needs no special handling here.

## Four real fixes carried over from the Oracle attempt

Found live while staging that migration - all still apply here, none
architecture-specific:

1. **Carry `FLEET_SERVER_PRIVATE_KEY` over exactly, never regenerate.**
   This deployment doesn't store the APNs certificate as mounted PEM
   files - it's uploaded once through Fleet's own setup wizard and
   stored **encrypted in MySQL**, using this exact key
   (`mac/fleet/fleet/fly.toml`'s own comment: "Fleet uses this to
   encrypt sensitive data at rest - e.g. the APNs cert private key once
   you upload it"). Import the MySQL dump on Hetzner under a
   *different* `FLEET_SERVER_PRIVATE_KEY` and Fleet has the encrypted
   cert but can't read it - MDM push breaks, with no error at deploy
   time. Same "copy the exact value, never regenerate" treatment the
   APNs cert itself needs (Phase 3 below).
2. **Set `FLEET_LICENSE_KEY`.** Missing this silently downgrades a
   Premium deployment to Free on the new host - no error, just Recovery
   Lock and the other Premium features quietly gone. The real key is
   whatever was entered when Fleet Premium was purchased (see Phase 1's
   row in `mac/README.md`) - carry it into the new `.env`, same
   "exact value, not regenerated" treatment as the two secrets above.
3. **Pin the Fleet image to an explicit version, not `:latest`.** Using
   `fleetdm/fleet:latest` means a future `docker compose pull` can jump
   several Fleet versions at once with no warning and no chance to read
   release notes first. Pinned to `v4.90.1` below - update deliberately,
   not implicitly, if a newer version is ever wanted.
4. **Restore the MySQL dump BEFORE running `fleet prepare db`, not
   after.** The dump's own `DROP TABLE`/`CREATE TABLE` statements would
   wipe out anything `prepare db` had just created if run first. `fleet
   prepare db` is idempotent (safe to run against an already-populated,
   already-current schema) so running it *after* the restore, as a
   safety net, is correct; running it *before* is the bug found live
   during the Oracle attempt (Phase 4 below has the right order).

A fifth thing, not a fix but a real simplification carried over too:
the tunnel. Fleet's real Public Hostname binding lives in Cloudflare's
tunnel config, not tied to which machine runs `cloudflared` -
**reusing the same tunnel entity** (a fresh connector token for it,
since Fly's distroless cloudflared image doesn't let you read the
original `TUNNEL_TOKEN` back out - see Phase 5) on the Hetzner instance
means the hostname never changes, so the Mac never needs
re-enrollment.

## Prerequisites

- [ ] Hetzner Cloud account created, a project set up
- [ ] SSH key added to the Hetzner project (reuse the same
      `~/.ssh/id_ed25519.pub` already generated for the Oracle attempt -
      no need for a second keypair)
- [ ] A domain on Cloudflare with DNS managed there (already true - same
      Cloudflare account/zone `panel.lukep009.download` and Fleet's own
      tunnel hostname already live on)
- [ ] `contentguard-fleet`, `-mysql`, `-redis`, `-tunnel` all currently
      healthy on Fly (`fly status --app <name>` for each)
- [ ] The Mac is enrolled and MDM profiles are applied (already true per
      Phase 1's own closed status in `mac/README.md`)
- [ ] The real secrets recovered during the Oracle attempt are still on
      hand (MySQL root/user passwords, Redis password,
      `FLEET_SERVER_PRIVATE_KEY`, `FLEET_LICENSE_KEY`) - if they were
      saved somewhere durable (the Phase 5 vault, or a scratch note),
      no need to re-run `fly secrets list`/re-derive them; if not,
      Phase 3 below re-gathers them from Fly the same way

## Phase 1 - Provision the Hetzner server

Hetzner Cloud Console -> **Add Server**:

- **Location**: Singapore (`sin`) - closest Hetzner region to Australia,
  best APAC latency for the Mac's tunnel connection. (Ashburn/`ash`, US,
  is the other non-EU option if that ever matters more than latency -
  not needed here.)
- **Image**: Ubuntu 24.04 - Hetzner's standard default, and matches the
  `apt`-based Docker install below (unlike Oracle Linux's `dnf`).
- **Type**: shared vCPU, **CX22** (2 vCPU / 4GB RAM / 40GB disk) - plenty
  for Fleet + MySQL + Redis at this project's real scale (one Mac).
  Bump to CX32 later if it's ever genuinely tight; no reason to
  over-provision up front.
- **Networking**: leave public IPv4 on (Hetzner doesn't have Oracle's
  quick-create-flow quirk where this gets greyed out). Firewall: only
  port 22 inbound - matches this stack's own existing "nothing public
  except the tunnel" design exactly, nothing to change about that
  philosophy.
- **SSH key**: select the one added in Prerequisites.

Confirm the real monthly price shown in the Console before creating it
(pricing can change) - should be in the same ballpark as the ~€4.35/mo
checked above, not assumed without looking.

## Phase 2 - Set up the Hetzner instance

```bash
ssh root@<hetzner-server-public-ip>   # Hetzner's Ubuntu images log you straight in as root
```

Docker + Compose (Ubuntu):

```bash
apt update
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
```

(Running as `root` directly, Hetzner's default for these images - no
`usermod`/re-login dance needed the way Oracle's non-root `opc` user
required.)

cloudflared (amd64 - Hetzner's CX22 is genuinely x86_64, unlike
Oracle's Ampere A1):

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
mv cloudflared /usr/local/bin/
```

No `cloudflared tunnel login`/`cloudflared tunnel create` needed - Phase
5 below reuses the existing tunnel entity via a fresh connector token
instead of creating a new tunnel.

## Phase 3 - Export everything from Fly.io (don't shut anything down yet)

**Gather the real secrets first**, if not already on hand from the
Oracle attempt (see Prerequisites) - these are the exact values this
deployment actually uses, not generic placeholders:

```bash
fly secrets list --app contentguard-fleet-mysql   # MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD (names only - fly doesn't echo values)
fly secrets list --app contentguard-fleet-redis    # REDIS_PASSWORD
fly secrets list --app contentguard-fleet          # FLEET_MYSQL_PASSWORD, FLEET_REDIS_PASSWORD, FLEET_SERVER_PRIVATE_KEY
fly secrets list --app contentguard-fleet-tunnel   # TUNNEL_TOKEN
```

`fly secrets list` only confirms names exist, never values - if these
weren't saved somewhere durable when first generated
(`mac/fleet/README.md`'s own setup steps say to), there's no way to
read them back out of Fly at all. If `FLEET_SERVER_PRIVATE_KEY`
specifically is genuinely lost, stop here - regenerating it means the
APNs cert becomes permanently undecryptable and MDM push needs to be
re-set-up with Apple from scratch, exactly like losing the cert itself.

**Dump MySQL** (real app name, real database name). Take this dump
fresh here, even if a dump already exists from the Oracle attempt - the
existing one is a "hot," point-in-time snapshot from whenever that
attempt happened, not necessarily current, and the real cutover in
Phase 6 needs one more, final, current dump anyway right before the
switch:

```bash
fly proxy 3307:3306 -a contentguard-fleet-mysql
# in a second terminal:
mysqldump -h 127.0.0.1 -P 3307 -u fleet -p fleet > fleet-backup.sql
# password prompt: the real MYSQL_PASSWORD value from Phase 3's secrets step
```

**No separate APNs cert file to copy** - this deployment's APNs cert
lives inside `fleet-backup.sql` itself (encrypted with
`FLEET_SERVER_PRIVATE_KEY`), not as standalone PEM files anywhere on
the Fly instance. The dump above already has it.

Copy the dump onto the Hetzner instance:

```bash
scp fleet-backup.sql root@<hetzner-server-public-ip>:~/fleet/fleet-backup.sql
```

## Phase 4 - Deploy Fleet on Hetzner

```bash
mkdir -p ~/fleet && cd ~/fleet
```

`docker-compose.yml` - same corrected shape as the Oracle attempt, with
every `platform: linux/arm64` line removed (native amd64 here, no
platform override needed at all), `FLEET_LICENSE_KEY` added, the image
pinned to `v4.90.1`, and Redis actually password-protected:

```yaml
services:
  mysql:
    image: mysql:8.0
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
    restart: always
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes --dir /data
    volumes:
      - redis_data:/data

  fleet-prepare:
    image: fleetdm/fleet:v4.90.1
    depends_on: [mysql, redis]
    environment:
      FLEET_MYSQL_ADDRESS: mysql:3306
      FLEET_MYSQL_DATABASE: fleet
      FLEET_MYSQL_USERNAME: fleet
      FLEET_MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    command: fleet prepare db --no-prompt
    restart: "no"

  fleet:
    image: fleetdm/fleet:v4.90.1
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
      FLEET_LICENSE_KEY: ${FLEET_LICENSE_KEY}
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
FLEET_LICENSE_KEY=<real Fleet Premium license key - MUST be set, or Premium features (Recovery Lock) silently disappear>
```

Bring up MySQL/Redis first, **restore the dump, then run `fleet
prepare db` as an idempotent safety net afterward** - this order,
restore-then-prepare, is the fix for the bug found live during the
Oracle attempt (running `prepare db` first would let its own `CREATE
TABLE`s get wiped out by the dump's `DROP TABLE` statements):

```bash
docker compose up -d mysql redis
sleep 15   # let MySQL finish initializing before anything else touches it
docker compose exec -T mysql mysql -u fleet -p"$MYSQL_PASSWORD" fleet < ~/fleet/fleet-backup.sql
docker compose run --rm fleet-prepare
docker compose up -d fleet
docker compose logs fleet   # watch for a clean startup, no decrypt/auth errors
curl http://localhost:8080/healthz   # should return OK
```

## Phase 5 - Point the existing tunnel at Hetzner instead of Fly

No new tunnel, no DNS change - same tunnel identity, just a fresh
connector token for it, run from Hetzner instead of Fly. (Fly's
distroless cloudflared image doesn't let the original `TUNNEL_TOKEN` be
read back out, so this is a new token for the *same* tunnel, not a new
tunnel - the Public Hostname binding, and therefore the hostname the
Mac already trusts, stays identical either way.)

1. Cloudflare Zero Trust dashboard -> **Networks > Tunnels** -> the
   existing `contentguard-fleet` tunnel -> **Configure** ->
   **generate/copy a new connector token** for it (don't create a new
   tunnel - reuse this same one).

```bash
cloudflared tunnel run --token "<the new connector token>"
```

Confirm it connects (Cloudflare Zero Trust dashboard -> Networks ->
Tunnels -> should show **Healthy**, sourced from the Hetzner instance
now) before making it permanent:

```bash
cloudflared service install --token "<the new connector token>"
systemctl enable --now cloudflared
```

**Do not touch the tunnel's Public Hostname config in the Cloudflare
dashboard at all** - that's what makes this safe. The hostname keeps
pointing at the same tunnel; only which machine answers, and which
connector token it uses, changed.

## Phase 6 - Verify before touching Fly at all

Since the tunnel identity never changed, this should be a non-event -
worth confirming for real anyway, not assumed:

- [ ] Fleet's UI at the real hostname shows the Mac as enrolled, recently checked in
- [ ] `sudo profiles list` on the Mac (or Fleet's own host detail page) shows every profile still applied
- [ ] Push a trivial change from Fleet's UI (e.g. edit a profile's own label) and confirm it lands
- [ ] APNs push works - trigger any real MDM command from Fleet and confirm the Mac responds
- [ ] Fleet Premium features are actually active (Recovery Lock still
      shows as available on the host page) - confirms `FLEET_LICENSE_KEY`
      actually took
- [ ] `sudo santactl sync --debug` on the Mac still completes cleanly - Santa syncs through this
      project's own Cloudflare Worker (`panel.lukep009.download`), not Fleet directly, so this
      should be completely unaffected either way, but confirm rather than assume
- [ ] ContentGuard Central / the dashboard's Fleet-backed pages (`/central/`'s Fleet MDM and App
      control tabs, or the existing dashboard's own MDM lockdown section) still load real data -
      both call Fleet only indirectly, through this Worker's own `FLEET_BASE_URL`/`FLEET_API_TOKEN`
      secrets, which point at the tunnel hostname, not at Fly directly - should need no change,
      confirm rather than assume

## Phase 7 - Only once Phase 6 fully passes: final cutover and shut down Fly

The dump restored in Phase 4 was taken before this cutover step, so
anything that changed on the live Fly instance in the meantime (new
Santa syncs, new MDM check-ins) wouldn't be in it. Do a final, clean
cutover rather than trusting the earlier dump as the last word:

1. Put the Mac's/Fleet's traffic on pause conceptually (no changes made
   through Fleet's UI during this step).
2. Re-dump Fly's MySQL one more time (same command as Phase 3).
3. Restore that fresh dump into Hetzner's MySQL (same restore command
   as Phase 4 - MySQL's own `DROP TABLE`/`CREATE TABLE` in the dump
   handles replacing what's there cleanly).
4. Restart the `fleet` container (`docker compose restart fleet`) and
   re-run Phase 6's checklist once more against this final state.

Once that passes:

```bash
fly apps destroy contentguard-fleet
fly apps destroy contentguard-fleet-mysql
fly apps destroy contentguard-fleet-redis
fly apps destroy contentguard-fleet-tunnel
```

Keep `fleet-backup.sql` somewhere durable - not deleted, and not just on
the Hetzner instance itself (see Phase 8).

## Phase 8 - Automated backups (Hetzner has none built in by default)

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
new scope beyond the migration itself). Optionally, Hetzner also sells
an automated-snapshot add-on for the server itself (a real, small extra
monthly cost) - not required given the cron-based dump above already
covers the actual data that matters (the MySQL database), but worth
knowing it's there as a second, coarser layer.

No idle-reclamation phase needed here, unlike the Oracle attempt -
Hetzner is a normal paid VM, not an Always-Free tier with capacity
reclamation risk. Nothing to keep artificially busy.

## Rollback

Fly.io stays untouched through Phase 6 - if anything looks wrong, just
run `cloudflared tunnel run --token "..."` back on the OLD Fly tunnel
app instead of Hetzner (or simply don't run Phase 7's `fly apps
destroy` commands). Since the tunnel identity never changed, rollback
is "point the connector back," not "re-provision and re-enroll."

## What NOT to touch

- COMMAND (a different, unrelated repo - confirmed with the user, no
  special handling needed)
- The APNs certificate - never regenerate; same applies to
  `FLEET_SERVER_PRIVATE_KEY` (see the "four real fixes" section above)
- MDM profiles on the Mac - persist regardless of where Fleet runs
- Cloudflare Gateway/WARP/DNS - unaffected, all Cloudflare-side
- `worker/`'s own `FLEET_BASE_URL`/`FLEET_API_TOKEN` secrets - point at
  the tunnel hostname, which doesn't change in this plan, so these
  shouldn't need updating; confirm in Phase 6 rather than assume
- Santa's `SyncBaseURL` (`profiles/santa-config.mobileconfig`) - already
  points at this project's own Worker, not Fleet, unaffected either way

## Post-migration checklist

- [ ] Hetzner instance running, mysql/redis/fleet containers all healthy
- [ ] Tunnel showing Healthy in Cloudflare, sourced from Hetzner
- [ ] Mac enrolled and checking in, all profiles still applied
- [ ] APNs push confirmed working with a real test command
- [ ] Fleet Premium features (Recovery Lock) confirmed still active
- [ ] Automated daily MySQL backups running, synced off-instance
- [ ] Fly.io Fleet apps destroyed (all four)
- [ ] `fleet-backup.sql` kept somewhere durable, off the Hetzner instance
