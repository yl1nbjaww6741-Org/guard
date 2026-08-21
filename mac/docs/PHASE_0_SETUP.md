# Phase 0 - Mac first-boot setup

Do this the moment you turn on the new Mac, before anything from Phase 1
(Fleet enrollment) touches it. Everything here is manual - System Settings,
the App Store, a browser. `scripts/verify-phase0.sh` checks the parts of it
that are machine-verifiable once you think you're done; the rest (Find My
Mac, the Gateway/WARP dashboard config) has to be eyeballed in System
Settings / the Cloudflare dashboard, since macOS doesn't expose a reliable
CLI signal for them.

Keep a scratch note going as you work through this - the passwords and
keys called out below all get sealed into the timelock vault in Phase 5.
Nothing here should end up in this repo, in shell history that survives, or
anywhere else outside that vault.

## 0.1 Create accounts

- Create your daily account. This is the one you'll actually use day to
  day, and it's the one that gets demoted to standard in Phase 5 - so
  create it as the account you want to keep using, not a throwaway.
- Create a second, separate **admin** account with a long, random,
  generated password (not one you know from memory - pull it from a
  password manager's generator). Give it a boring name (e.g. `sysadmin`)
  rather than your own name; you'll hide it from the login screen in
  Phase 5.
- Write the admin password down somewhere temporary and offline. It goes
  into the vault in Phase 5, not before.

## 0.2 Enable FileVault

1. System Settings -> Privacy & Security -> FileVault -> Turn On.
2. Once it's on, remove the admin account from the unlock list so only
   your daily account can unlock the disk at boot:

   ```bash
   sudo fdesetup remove -user sysadmin
   ```

3. Confirm only your daily account is listed:

   ```bash
   sudo fdesetup list
   ```

4. Save the FileVault recovery key macOS shows you. It goes into the vault
   in Phase 5.

## 0.3 Enable Find My Mac

System Settings -> Apple ID -> iCloud -> Find My Mac -> On. This also
activates Activation Lock. The iCloud account password goes into the vault
in Phase 5 - without it, Activation Lock is permanent if the vault is ever
lost, so don't lose the vault.

There's no reliable CLI check for this one; confirm it's on by eye in
System Settings.

## 0.4 Install dev tools

Install everything you'll need day to day **before** Phase 1 locks
anything down:

- **Xcode**, from the App Store (needed to build the native blocker in
  Phase 2).
- **Homebrew**, if you use it: <https://brew.sh>
- **Google Chrome** - the one browser Phase 1's Chrome policy profile and
  Phase 3's Santa allowlist assume you're using.
- Anything else you use daily - editor, terminal replacement, whatever.
  Install it all now; Phase 3 will only allowlist what's already on the
  Mac when you build the Santa rules.
- **Fly.io CLI** (Phase 1 deploys Fleet there):

  ```bash
  brew install flyctl
  # or: curl -L https://fly.io/install.sh | sh
  ```

- **Node.js + npm** (Phase 4's Worker and dashboard).
- **Cloudflare Wrangler**:

  ```bash
  npm install -g wrangler
  ```

## 0.5 Configure Cloudflare Zero Trust (from the Mac's browser)

Assuming you already have a Zero Trust org:

- Confirm Gateway DNS policies block adult/NSFW categories.
- Configure the WARP device profile: full tunnel, auto-connect on a short
  interval. Leave the **switch-lock OFF** for now - you want the ability
  to disconnect while you're still setting things up. It gets locked at
  the end of Phase 1, after verification.
- Admin override: OFF.
- Global WARP override: OFF.

## 0.6 Install Cloudflare WARP

1. Download and install the WARP client.
2. Enrol it to your Zero Trust org.
3. Verify it connects - tunnel up, traffic flowing through Gateway.
4. Leave the switch unlocked for now; Phase 1's verification step locks it
   once everything else checks out.

## Phase 0 is complete when

- [ ] Two accounts exist: your daily account and a separate admin account
      with a strong, generated password.
- [ ] FileVault is on, and `sudo fdesetup list` shows only your daily
      account (not the admin account).
- [ ] The FileVault recovery key is saved somewhere temporary, off this
      Mac, pending the vault in Phase 5.
- [ ] Find My Mac / Activation Lock is on.
- [ ] Xcode, Chrome, and every app you use daily are installed.
- [ ] `flyctl`, Node/npm, and `wrangler` are installed.
- [ ] WARP is installed, enrolled, and connected (unlocked).

Run `../scripts/verify-phase0.sh` to check the parts of this that a script
can see. Once every box above is checked - by the script where it can
check, by eye where it can't - move on to Phase 1.
