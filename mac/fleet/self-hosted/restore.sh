#!/usr/bin/env bash
# The inverse of backup.sh - pulls the latest (or a chosen) restic
# snapshot from Cloudflare R2 and rehydrates both databases on a fresh
# box, before you bring the stack up for the first time there.
#
# Usage:
#   ./restore.sh                 # restore the latest snapshot
#   ./restore.sh <snapshot-id>   # restore a specific one - `restic snapshots` to list
#
# Run this BEFORE `docker compose up -d` on the new box: it needs mysql
# and redis containers running (for mysql to load into) but fleet itself
# should stay down until the data's in place, so migrations don't race a
# half-restored database.
#
#   docker compose up -d mysql redis
#   ./restore.sh
#   docker compose up -d

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# shellcheck disable=SC1091
source .env

export RESTIC_REPOSITORY="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export RESTIC_PASSWORD

SNAPSHOT="${1:-latest}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "[$(date -Is)] fetching snapshot '$SNAPSHOT' from R2..."
restic restore "$SNAPSHOT" --target "$WORKDIR"

# restic restore preserves the original absolute path under $WORKDIR -
# find the two files we backed up regardless of the exact tmpdir name
# backup.sh happened to use.
DB_DUMP="$(find "$WORKDIR" -name 'fleet-db.sql' -print -quit)"
SQLITE_FILE="$(find "$WORKDIR" -name 'command.sqlite' -print -quit)"

if [ -z "$DB_DUMP" ]; then
  echo "[!] No fleet-db.sql found in that snapshot - aborting." >&2
  exit 1
fi

echo "[$(date -Is)] waiting for mysql to be reachable..."
until docker compose exec -T mysql mysqladmin ping -h localhost -u root -p"${MYSQL_ROOT_PASSWORD}" --silent; do
  sleep 2
done

echo "[$(date -Is)] restoring MySQL dump into '${MYSQL_DATABASE}'..."
docker compose exec -T mysql \
  mysql -u root -p"${MYSQL_ROOT_PASSWORD}" "${MYSQL_DATABASE}" < "$DB_DUMP"

if [ -n "$SQLITE_FILE" ]; then
  echo "[$(date -Is)] restoring Command's SQLite file..."
  # TODO: same path caveat as backup.sh - confirm once command/ is filled in.
  docker compose cp "$SQLITE_FILE" command:/data/command.sqlite
else
  echo "[!] No command.sqlite in that snapshot - Command will start with an empty database."
fi

echo "[$(date -Is)] done. Bring the rest of the stack up now: docker compose up -d"
