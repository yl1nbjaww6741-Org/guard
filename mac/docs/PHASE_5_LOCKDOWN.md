# Phase 5 - Lockdown: demote to standard, seal admin credentials

**Not started. This is a runbook to follow by hand on the physical Mac -
same as `PHASE_0_SETUP.md`, nothing here is scriptable from a sandboxed
session with no access to the hardware.** Read the whole thing before
starting anything - this is the one phase in the whole build that's
deliberately hard to walk back, and the failure mode if you skip a step
or do them out of order is locking yourself out of a Mac that doesn't
yet do what it's supposed to.

## Before you start

Everything else in this project (Phases 1-4, plus this session's Chrome
extension + browser/torrent MDM lockdown) was built and verified with
you holding admin rights the whole time - meaning every "confirmed
working on the real Mac" claim in `mac/README.md` was tested with an
easy escape hatch available if something broke. Phase 5 removes that
escape hatch on purpose. Before demoting anything:

- [ ] You have physical access to this Mac right now, and expect to for
      the next hour or so - not doing this remotely, not doing it right
      before you need to leave.
- [ ] You know exactly where the FileVault recovery key (saved back in
      Phase 0.2) and the admin account's password currently live, and
      can reach both without needing the Mac itself to get them.
- [ ] Fleet's Recovery Lock (set in Phase 1) is still active - if MDM
      enrollment itself ever breaks, that's the real backstop for
      getting back in, independent of the local account structure this
      phase changes.

If any of those three aren't true yet, stop and fix that first - none
of them are part of Phase 5 itself, they're the safety net underneath
it.

## 5.0 Prerequisites - must land before demotion, not after

Three items were deliberately deferred from earlier phases specifically
because they belong here, per `mac/README.md`'s own Phase 0/1 rows:

### 5.0.1 Enable FileVault (deferred from Phase 0.2)

Per `PHASE_0_SETUP.md`'s own checklist, not yet confirmed done:

1. System Settings -> Privacy & Security -> FileVault -> Turn On.
2. Remove the admin account from the unlock list so only the daily
   account can unlock the disk at boot:
   ```bash
   sudo fdesetup remove -user sysadmin
   ```
3. Confirm only the daily account is listed:
   ```bash
   sudo fdesetup list
   ```
4. Save the FileVault recovery key macOS shows you - this is one of the
   items that goes into the vault in 5.5 below, not before.

### 5.0.2 Admin account rename

Per `PHASE_0_SETUP.md`'s 0.1, the admin account should already have a
boring, non-identifying name (e.g. `sysadmin`) rather than a real name -
confirm that's actually the case; if the admin account still carries an
identifying name from whenever it was first created, rename it now
(System Settings -> Users & Groups, or `sudo sysadminctl -deleteUser`
+ recreate is the only fully clean path if the short name itself needs
to change, since macOS doesn't support renaming a Unix short name
in-place without side effects - check which situation you're actually
in on this Mac before picking either route).

### 5.0.3 Rotate the Cloudflare Tunnel connector token

Per `mac/fleet/README.md`, Fleet's public reachability runs through a
`cloudflared` tunnel on Fly.io, authenticated by a connector token set
as that app's `TUNNEL_TOKEN` secret. Rotate it now, before locking
anything else down, so a credential that's been sitting untouched since
Phase 1 isn't carried forward unrotated into a phase specifically about
tightening credential hygiene:

1. Cloudflare Zero Trust dashboard -> Networks -> Tunnels -> the tunnel
   used for Fleet -> regenerate/rotate its connector token.
2. Update the Fly.io secret with the new value:
   ```bash
   fly secrets set --app contentguard-fleet-tunnel TUNNEL_TOKEN="<new connector token>"
   ```
3. Confirm the tunnel reconnects (`fly logs --app contentguard-fleet-tunnel`
   or the Cloudflare dashboard's tunnel status) and Fleet is still
   reachable before moving on.

## 5.1 Pre-demotion verification pass

Re-run every earlier phase's own verification checklist one more time,
right before pulling the trigger - not because anything's expected to
have broken, but because this is the last point where fixing a
regression is a one-admin-password problem instead of a
boot-into-sysadmin problem:

- **Phase 1**: Mac still shows enrolled and supervised in Fleet; Recovery
  Lock still set; WARP switch still locked; Gateway NSFW/DoH blocks
  still active.
- **Phase 2**: `ContentGuardAgent`/`ContentGuardDaemon` both running
  (`launchctl print` shows live pids), a real detection still triggers
  correctly, sleep/wake resume still works.
- **Phase 3**: `santactl status` shows `Mode: Monitor`, Tor Browser still
  genuinely blocked, ContentGuard's own cert still allowlisted.
- **Phase 4**: dashboard still reachable and logs in, a ratchet
  loosen-request still queues with the real 24h delay.
- **This session**: Chrome extension still shows "installed by your
  administrator" with no remove control, a non-Chrome browser and a
  torrent client (if installed) both still refused, Chrome itself still
  opens.

Every one of these needs to keep working under the **daily account once
it's standard**, not just under admin right now - Phase 3's whole design
already assumes this (`forceAdminPasswordForAppInstallation=false`,
standard users install freely, Santa/Phase 2 are the real backstops
regardless of account type), so nothing here is expected to depend on
admin rights. Confirming that assumption still holds live is the point
of this pass, not a formality.

## 5.2 Demote the daily account to standard

1. Log into the **admin** (`sysadmin`) account - the daily account can't
   remove its own admin rights while logged into itself.
2. System Settings -> Users & Groups -> select the daily account ->
   turn off "Allow user to administer this computer."
3. Verify from the command line, still in the admin account:
   ```bash
   dscl . -read /Groups/admin GroupMembership
   ```
   Confirm the daily account's short name is no longer listed.
4. Log out of `sysadmin`, log back into the daily account. Confirm
   System Settings shows it as Standard, and that an action requiring
   admin rights (installing certain system software, changing certain
   System Settings panes) now prompts for the `sysadmin` password rather
   than just proceeding.

## 5.3 Hide the admin account from the login screen

```bash
sudo dscl . append /Users/sysadmin IsHidden 1
sudo defaults write /Library/Preferences/com.apple.loginwindow HiddenUsersList -array-add sysadmin
```

Verify by logging out and confirming only the daily account is
selectable at the login screen. **Real limitation, not a false sense of
security**: this hides the account from the UI, it doesn't meaningfully
restrict access to it - a known key sequence still surfaces hidden
accounts on the macOS login screen. The actual security boundary is the
admin account no longer being reachable without its own long, random,
vault-only password (5.5) plus it being out of FileVault's unlock list
(5.0.1) - hiding it is obscurity on top of that, not a substitute for it.

## 5.4 Confirm nothing regressed

Re-run 5.1's entire checklist again, this time actually logged in as the
now-standard daily account rather than admin. Anything that passed under
admin but fails now is a real regression to fix before moving on to
5.5 - don't seal credentials into a vault while something's still
silently depending on admin rights to function.

## 5.5 Seal credentials into the vault

"Vault" means something genuinely not reachable from the daily standard
account on this same Mac - a password manager tied to a different
device/account, or a physical safe. A vault the standard account can
itself unlock defeats the entire point of this phase. Goes in:

- [ ] The `sysadmin` account's password
- [ ] The FileVault recovery key (from 5.0.1)
- [ ] Fleet's Recovery Lock PIN (from Phase 1)
- [ ] The rotated Cloudflare Tunnel connector token (from 5.0.3) - or
      wherever else the live value is recorded; the vault should hold
      what's needed to regenerate/verify it, not necessarily the raw
      live secret if that's better kept in Fly's own secret store
- [ ] The dashboard's login password (Phase 4)
- [ ] `SANTA_SYNC_TOKEN` / `CONTENTGUARD_EXTENSION_SYNC_TOKEN` (Phase 4 /
      this session)
- [ ] `build/dist/key.pem`, the Chrome extension's signing key (this
      session - flagged earlier as still needing this exact step)
- [ ] Any Cloudflare API token currently in active use (rotate first if
      it's ever appeared in a session transcript, per this project's own
      established practice this session already followed once)

## 5.6 Final check

- [ ] Daily account is Standard, confirmed logged-in-as, not just set
- [ ] Admin account hidden from login screen, long random password, not
      memorized anywhere
- [ ] FileVault on, admin account confirmed absent from `fdesetup list`
- [ ] Every credential in 5.5's list is in the vault, not just noted as
      "needs to go in the vault"
- [ ] 5.1's full cross-phase verification pass re-run and re-passed
      under the standard account (5.4)
- [ ] A written recovery procedure exists for "genuinely locked out" -
      where the vault physically is, how to reach it without the Mac
      itself, and that Fleet's Recovery Lock is the backstop if local
      account recovery somehow fails too

Once every box above is real and checked, Phase 5 - and the whole
six-phase build - is complete.
