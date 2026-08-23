# Cutover: moving to another VPS

Covers both cases - Oracle actually got suspended/terminated (reactive),
and you're just deciding to move on purpose (proactive, e.g. Oracle's
free capacity never came through, or you want more headroom than 12GB
eventually). The procedure is identical either way; only how much time
pressure you're under differs.

## The property that makes this fast

`docker-compose.yml`'s services address each other by Compose service
name (`mysql`, `fleet`, `command`) - not Oracle's or Hetzner's private
network DNS. `cloudflared`'s Public Hostname routes in the Cloudflare
dashboard point at those same service names too. None of that changes
when the box underneath changes. What moves is: the box itself, and the
two databases (MySQL + Command's SQLite) via `backup.sh`/`restore.sh`.
DNS, the tunnel's public hostname, and Fleet/Command's own configuration
are untouched.

## Procedure

1. **Provision the new box.** `provision-hetzner.md` (or wherever you're
   moving to - the same restore process works on any Docker host).

2. **Bring up just the databases first:**
   ```bash
   docker compose up -d mysql redis
   ```

3. **Restore the latest backup:**
   ```bash
   ./restore.sh
   ```
   (Or a specific snapshot - `restic snapshots` lists them all, if you
   need something other than the most recent one, e.g. rolling back past
   a bad migration rather than recovering from a lost box.)

4. **Bring up the rest:**
   ```bash
   docker compose up -d
   ```

5. **Repoint the tunnel.** In the Cloudflare Zero Trust dashboard, the
   existing tunnel's connector token is what `cloudflared` on the new box
   authenticates with (`TUNNEL_TOKEN` in `.env`) - reuse the *same*
   token rather than creating a new tunnel. Once the new box's
   `cloudflared` container is up and shows **Healthy** in the dashboard,
   the old box's `cloudflared` can come down. If both are briefly running
   at once (new box coming up before the old one's torn down), Cloudflare
   load-balances between them rather than erroring - so this can be a
   near-zero-downtime handover if you bring the new one up before killing
   the old one, not just a hard cutover.

6. **Verify before tearing down the old box:**
   - Fleet's dashboard loads at its usual hostname and the Mac still
     shows as enrolled/supervised (Fleet's own state came from the
     restored MySQL dump, so this should just work - but confirm it,
     don't assume it)
   - Command loads and the data restored looks right
   - `docker compose logs -f cloudflared` on the new box shows the
     tunnel connected, no repeated reconnect loops

7. **Only then**, decommission the old box (`hcloud server delete` /
   terminate the Oracle instance, whichever direction you moved).

## Rehearse this once, before you need it for real

Everything above is unverified until it's actually been run - same
discipline the rest of this project already holds itself to (see
`../README.md`'s Phase 2 log: nothing gets marked "confirmed working"
without having genuinely happened on real hardware, not just having been
written correctly).

Concretely: once the stack's been running on Oracle for a few days with
`backup.sh` actually producing snapshots, spin up a real (temporary)
Hetzner `cx22` - the cheapest tier, ~$4.35 for however many hours this
takes - and run this entire procedure against it for real. Confirm Fleet
and Command both come up correctly with real restored data, then tear the
rehearsal box back down. This turns "the runbook should work" into "the
runbook worked, once, for real" - the same gap this project's own history
(`../README.md`) keeps finding between "built" and "verified working."
