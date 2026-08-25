# Packaging & hosting the extension for MDM force-install

This is the last step before the extension can be locked down via
`profiles/chrome-policy.mobileconfig`'s `ExtensionInstallForcelist` -
force-installed by Chrome policy instead of manually loaded via
"Load unpacked" (which needs Developer mode on, the thing we're trying
to lock down in the first place).

**Run this yourself, in your own Codespace - not something to hand to a
remote assistant to run.** `package-crx.sh` generates a permanent
signing key on first run (`build/dist/key.pem`) - that key needs to stay
under your own control from the moment it's created. See the script's
own header comment for exactly what's at stake if it's lost or leaked.

## One-time setup

1. **Create the R2 bucket** the built `.crx` gets uploaded to (from
   `worker/`):
   ```bash
   npx wrangler r2 bucket create contentguard-extension
   ```
   Matches `wrangler.toml`'s `[[r2_buckets]]` binding - same name, or
   the binding won't resolve to anything.

## Every time you package/re-package the extension

1. **Bump the version** in `chrome-extension/manifest.json` if this is
   a real update (not the very first package), and update
   `worker/src/extensionUpdate.ts`'s `EXTENSION_VERSION` constant to
   match exactly - Chrome only fetches a new `.crx` when the server's
   `update.xml` reports a version newer than what's installed. An
   unbumped version here means Chrome silently never re-checks.

2. **Package it** (from `chrome-extension/`):
   ```bash
   ./build/package-crx.sh
   ```
   Output lands in `build/dist/` (gitignored - `contentguard.crx`,
   `key.pem`, `update.xml`). The very first run creates `key.pem`; every
   run after that reuses it, so the extension ID stays the same across
   updates.

3. **Back up `build/dist/key.pem` somewhere outside this repo** -
   a password manager, a separate encrypted volume, wherever you keep
   other credentials. This step only matters the first time (later runs
   just reuse the same key), but it's the one moment this credential
   exists and could be lost for good.

4. **Upload the `.crx` to R2** (from `worker/`):
   ```bash
   npx wrangler r2 object put contentguard-extension/contentguard.crx --file=../chrome-extension/build/dist/contentguard.crx
   ```

5. **Report the extension ID** (printed by `package-crx.sh`, also in
   `build/dist/update.xml`'s `appid` attribute) so it can be filled into:
   - `worker/src/extensionUpdate.ts`'s `EXTENSION_ID` constant
   - `profiles/chrome-policy.mobileconfig`'s `ExtensionInstallForcelist`
     entry (replacing the `__AI_BLOCKER_EXTENSION_ID__` placeholder -
     `update_url` there is already correct: `https://panel.lukep009.download/extension/update.xml`)

   Both currently hold the same placeholder and need to move together -
   an ID that doesn't match between them means either Chrome's update
   check 404s or `ExtensionInstallForcelist` silently never resolves.

6. **Deploy the Worker** (`worker/src/extensionUpdate.ts`'s change goes
   out through the normal `git push` -> GitHub Actions deploy, same as
   everything else in `worker/`) and **push the updated MDM profile**
   through Fleet directly (`profiles/chrome-policy.mobileconfig` - same
   "outside this dashboard's own ratchet" reasoning as every other
   direct profile push this project has done, see
   `mac/docs/PHASE_4_DASHBOARD_SETUP.md`).

## Verifying it actually worked

On the Mac, once the MDM profile has landed:

1. Remove the manually-loaded unpacked copy from `chrome://extensions`
   (the "Remove" button - it should still be removable at this point,
   since it's not yet the policy-managed one).
2. Reload `chrome://extensions` (or restart Chrome) and confirm
   ContentGuard reappears on its own, marked "installed by your
   administrator" with no Remove/enable-disable controls.
3. Confirm `chrome://policy` shows `ExtensionInstallForcelist` applied
   with the real extension ID, not the placeholder.
4. *Then*, and only then, re-tighten `DeveloperToolsAvailability` back
   to `2` and push that too - the extension no longer needs Developer
   mode once it's genuinely policy-installed.
