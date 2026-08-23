# Provisioning on Hetzner (the fallback / paid path)

No capacity fight here - Hetzner just sells you the box. This is the path
to use either because `provision-oracle.sh` hasn't succeeded after a
day or two of retrying, or because a real cutover from Oracle is
happening (see `CUTOVER.md`).

## 1. Create the server

```bash
# hcloud CLI: https://github.com/hetznercloud/cli
hcloud context create contentguard   # first time only - asks for an API token
                                      # (Hetzner Console > Security > API Tokens)

hcloud ssh-key create --name contentguard --public-key-from-file ~/.ssh/id_ed25519.pub

hcloud server create \
  --name contentguard \
  --type cx32 \
  --image ubuntu-22.04 \
  --location sin \
  --ssh-key contentguard
```

`cx32` (4 vCPU / 8GB RAM / 80GB disk, ~$7.69/mo) - real headroom over the
~3-3.5GB the combined stack needs, not the tighter `cx22` (4GB). `sin`
(Singapore) matches where Command already runs today; Fleet doesn't care
about region since it's back-office MDM traffic to one Mac, not
latency-sensitive.

## 2. Lock it down

Hetzner servers get a public IP with nothing pre-filtered - unlike
Oracle's security-list model, you need your own firewall here:

```bash
hcloud firewall create --name contentguard-fw
hcloud firewall add-rule contentguard-fw --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0,::/0
# nothing else - cloudflared is outbound-only, no other inbound rule is needed
hcloud firewall apply-to-resource contentguard-fw --type server --server contentguard
```

(Tighten the SSH rule to your own IP/CIDR if it's stable - `0.0.0.0/0` is
the minimum-friction starting point, not the end state.)

## 3. Install Docker

```bash
ssh root@<the server's IP>
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin
```

## 4. Bring the stack up

```bash
git clone <this repo's URL>
cd guard/mac/fleet/self-hosted
cp .env.example .env   # fill in real values
docker compose up -d
```

If this is a **fresh start** (no prior Oracle deployment to carry over),
you're done - Fleet's setup wizard is reachable at whatever hostname the
Cloudflare Tunnel's Public Hostname points to.

If this is a **cutover from an existing box** (Oracle or otherwise),
stop here and follow `CUTOVER.md` instead - don't `docker compose up -d`
the `fleet`/`command` services until the databases are restored, or
you'll initialize an empty Fleet instance instead of migrating the real
one.

## 5. Backups, same as anywhere else

```bash
crontab -e
# 0 3 * * * cd /root/guard/mac/fleet/self-hosted && ./backup.sh >> /var/log/contentguard-backup.log 2>&1
```
