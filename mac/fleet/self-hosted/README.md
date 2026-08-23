# Self-hosted Fleet + Command (Oracle-first, Hetzner-ready)

This directory replaces the four-Fly-apps layout in `../fleet/`, `../mysql/`,
`../redis/`, `../tunnel/` with a single `docker-compose.yml` running the
whole stack - Fleet, its MySQL and Redis, `cloudflared`, and Command (the
budgeting app currently on Fly, `lukep009/command`) - on one box.

**Why this exists**: a cost review turned into a provider search (Fly ->
Hetzner -> Oracle -> Google -> Cloudflare -> "just Hetzner" -> back to
Oracle), landing on: start on **Oracle Cloud's Always Free tier** (2 OCPU /
12GB Ampere A1, $0/mo forever) because the whole combined workload
(~3-3.5GB) fits with real headroom, but insure against Oracle's two known
weak points - a fight to provision the free Ampere shape at all, and a
documented pattern of accounts getting suspended/terminated with no
warning and no SLA - by making the switch to a paid VPS (Hetzner CX32,
~$7.69/mo) a rehearsed, scripted, few-minutes operation instead of a
from-scratch rebuild.

The mechanism that makes that possible: **everything stateful is either
reproducible from this repo or backed up off-Oracle**, and **the
`docker-compose.yml` is provider-agnostic** - the exact same file runs on
Oracle, Hetzner, or anywhere else Docker runs, because services address
each other by Docker Compose service name (`mysql`, `fleet`, `command`),
not by any cloud's private-network DNS. Moving providers is: stand up a
box, install Docker, pull this repo, restore the latest backup, `docker
compose up -d`, point `cloudflared` at it with the same tunnel token.
Nothing about DNS, the tunnel's public hostname, or the app's own config
needs to change.

## Layout

| File | What |
|---|---|
| `docker-compose.yml` | The whole stack: `mysql`, `redis`, `fleet` (+ a one-shot `fleet-prepare-db` migration step), `cloudflared`, `command` |
| `.env.example` | Every secret the compose file needs - copy to `.env`, fill in, never commit `.env` itself |
| `backup.sh` | Nightly `mysqldump` + Command's SQLite file, encrypted and pushed to Cloudflare R2 via `restic` |
| `restore.sh` | The inverse of `backup.sh` - pulls the latest snapshot and rehydrates both databases on a fresh box |
| `provision-oracle.sh` | Retry-loop that fights for the free Ampere A1 shape (this is the genuinely annoying part - see the script's own comments) |
| `provision-hetzner.md` | The fallback path - no retry loop needed, Hetzner just sells you the box |
| `CUTOVER.md` | The actual "Oracle died / we're switching on purpose" runbook, plus a rehearsal checklist to run once before you need it for real |

## What's still a placeholder

`docker-compose.yml`'s `command` service (the Command app itself) is
stubbed - this session doesn't have read access to `lukep009/command`
(different GitHub org than this repo), so the build context, exact env
vars, and SQLite path are marked `TODO` rather than guessed. Fill those in
from Command's actual `Dockerfile`/`fly.toml`, or hand me that repo's
details and I'll complete it.

## Order of operations

1. Fill in `.env` (see `.env.example`).
2. Try `provision-oracle.sh` first. If it hasn't succeeded within a day or
   two of retrying, don't keep waiting on it - fall back to
   `provision-hetzner.md` immediately. Nothing else in this directory
   cares which one you end up on.
3. Once a box is up: install Docker + Compose, clone this repo,
   `docker compose up -d`.
4. Set up `backup.sh` as a scheduled job (systemd timer or cron) from day
   one, on whichever provider you land on - the backups are what make
   Oracle's risk acceptable *and* what makes a future voluntary move (to
   Hetzner, or anywhere else) low-effort. Don't skip this because you
   landed on Oracle "for now."
5. Run through `CUTOVER.md`'s rehearsal checklist once, deliberately,
   before you're relying on it under pressure - same verification
   discipline the rest of this project already follows (see `../README.md`'s
   Phase 2 log: nothing in this repo gets marked "done" without having
   actually been run for real).
