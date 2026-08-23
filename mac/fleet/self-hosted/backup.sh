#!/usr/bin/env bash
# Nightly backup of everything stateful in the stack, pushed off-box to
# Cloudflare R2 via restic (encrypted, deduplicated, versioned).
#
# This is the piece that makes Oracle's termination risk acceptable and a
# future voluntary move to another VPS low-effort - see ../README.md and
# CUTOVER.md. Run this from day one, regardless of which provider you're
# on; it costs nothing to have and everything to be missing.
#
# Setup (once, on whichever box is running docker-compose.yml):
#   crontab -e
#   0 3 * * * cd /path/to/mac/fleet/self-hosted && ./backup.sh >> /var/log/contentguard-backup.log 2>&1
# or the systemd-timer equivalent if this box already manages other jobs
# that way.
#
# Requires: docker compose (this stack already running), restic
# (https://restic.net - single static binary, `apt install restic` or
# download the release binary directly), and .env filled in (see
# .env.example) with R2_* and RESTIC_PASSWORD set.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck disable=SC1091
source .env

export RESTIC_REPOSITORY="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export RESTIC_PASSWORD

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "[$(date -Is)] dumping MySQL (fleet db)..."
docker compose exec -T mysql \
  mysqldump -u root -p"${MYSQL_ROOT_PASSWORD}" --single-transaction --routines --triggers "${MYSQL_DATABASE}" \
  > "$WORKDIR/fleet-db.sql"

echo "[$(date -Is)] copying Command's SQLite file..."
# TODO: confirm the real path once command/'s Dockerfile is filled in -
# this assumes the same /data/*.sqlite layout as the command_data volume
# comment in docker-compose.yml.
docker compose cp command:/data/command.sqlite "$WORKDIR/command.sqlite" \
  || echo "  [!] Command SQLite copy failed or path is wrong - see docker-compose.yml's TODO on the command service. Continuing with just the Fleet DB backed up."

echo "[$(date -Is)] initializing restic repo if this is the first run..."
restic snapshots >/dev/null 2>&1 || restic init

echo "[$(date -Is)] pushing snapshot to R2..."
restic backup "$WORKDIR" --tag contentguard --host "$(hostname)"

echo "[$(date -Is)] pruning old snapshots (keep 14 daily, 8 weekly, 6 monthly)..."
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune

echo "[$(date -Is)] done."
