# ContentGuard - Chrome extension

Phase A of the browser-side blocker: keyword blocking, synced from the
same dashboard as everything else. **Phase B (5-second screenshot
capture + the same NudeNet ONNX classifier the Mac app uses) is not
built yet** - this is keyword-only for now.

## What's here

- `manifest.json` - MV3 manifest.
- `background/service-worker.js` - polls the Worker's `/sync/keywords`
  every 5 minutes (plus immediately on install/startup/options-save),
  and turns the keyword list into `declarativeNetRequest` rules that
  block matching URLs before they load.
- `content-scripts/keyword-blocker.js` - the fallback for a keyword that
  only shows up in a page's rendered text/title, not its URL. Closes the
  tab on a match (see `background/service-worker.js`'s message
  listener).
- `options/options.html` + `options.js` - where the Worker URL and the
  extension's own sync token are configured. **The token is never
  hardcoded into this extension's source** - same discipline as every
  other secret in this project (Santa's sync token, the daemon's sync
  token, Fleet's API token - all provisioned separately, never
  committed). It's entered once through this page and stored only in
  this browser's local extension storage.

## Setup (do this once per Mac/Chrome install)

1. **Generate a token and set it on the Worker** (from the `worker/`
   directory, or wherever you run `wrangler`):
   ```bash
   openssl rand -hex 32   # copy this value
   npx wrangler secret put CONTENTGUARD_EXTENSION_SYNC_TOKEN
   # paste the generated value when prompted
   ```
   This is the same `wrangler secret put` pattern already used for
   `SANTA_SYNC_TOKEN`/`CONTENTGUARD_DAEMON_SYNC_TOKEN` - see
   `wrangler.toml`'s own comment block for all of them.

2. **Load the extension unpacked** (this hasn't been published anywhere
   yet - loading a local, unpacked directory is the real way to run and
   test it right now):
   - Chrome -> `chrome://extensions`
   - Enable "Developer mode" (top-right toggle)
   - "Load unpacked" -> select this `chrome-extension/` directory
   - Chrome assigns a 32-character extension ID at this point - worth
     noting down; it's what eventually goes into
     `profiles/chrome-policy.mobileconfig`'s `ExtensionInstallForcelist`
     placeholder once this extension gets locked from removal (see that
     file's own comment for the two paths - Chrome Web Store vs.
     self-hosted - and why locking removal needs a *published* extension,
     not this unpacked dev copy).

3. **Configure the extension**: click "Details" on the extension in
   `chrome://extensions`, then "Extension options" (or right-click the
   toolbar icon -> Options). Paste in:
   - Worker URL (e.g. `https://panel.lukep009.download`)
   - The token generated in step 1

4. **Test it**: add a keyword via the dashboard's new "Keyword blocker"
   section (takes effect immediately - no password, that's only needed
   to *remove* one). Within 5 minutes (or immediately, if you reload the
   extension from `chrome://extensions` to force a fresh
   `onInstalled`/`onStartup` sync), try navigating to a page whose URL or
   visible text contains that keyword and confirm it's actually blocked
   or the tab closes.

## Known, not-yet-verified-on-real-Chrome details

Written without a real browser available to load this into - flagging
honestly rather than asserting the confidence this project's Mac-side
code only earns after a real install (see `background/service-worker.js`'s
own header comment for the specific two items: `urlFilter` case
sensitivity, and the real `chrome.alarms` minimum period for a
policy-installed vs. unpacked-dev-mode extension). Please actually load
this and run through the Setup steps above before assuming it works -
same "confirmed on the real Mac, not assumed" standard as every other
component in this repo.
