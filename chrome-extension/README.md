# ContentGuard - Chrome extension

Phase A (keyword blocking) and Phase B (5-second screenshot capture +
the same NudeNet ONNX classifier the native Mac app uses) are both
built AND confirmed working end-to-end on a real Mac/real Chrome install
(2026-08-25) - a real test image was caught by the classifier and the
tab closed. Getting there took three real, live-found-and-fixed bugs
(see git history / this file's own comments in each source file): a
race between the sandbox iframe's "load" event and the model fetch, a
doubled `lib/lib/ort/...` path plus a missing vendored `.mjs` file, and
offscreen documents not actually having `chrome.tabs`/`chrome.windows`
access at all (moved the real capture calls to the service worker).
None of that was guessable in advance - real Chrome testing, each time,
is what actually found and confirmed each fix.

## What's here

**Phase A - keyword blocking:**
- `manifest.json` - MV3 manifest.
- `background/service-worker.js` - polls the Worker's `/sync/keywords`
  every 5 minutes (plus immediately on install/startup/options-save),
  and turns the keyword list into `declarativeNetRequest` rules that
  block matching URLs before they load. Also owns the offscreen
  document's lifecycle (see Phase B below) and the shared
  close-the-tab reaction both phases use.
- `content-scripts/keyword-blocker.js` - the fallback for a keyword that
  only shows up in a page's rendered text/title, not its URL. Closes the
  tab on a match.
- `options/options.html` + `options.js` - where the Worker URL and the
  extension's own sync token are configured. **The token is never
  hardcoded into this extension's source** - same discipline as every
  other secret in this project (Santa's sync token, the daemon's sync
  token, Fleet's API token - all provisioned separately, never
  committed). It's entered once through this page and stored only in
  this browser's local extension storage.

**Phase B - NSFW detection:**
- `background/offscreen.html` + `offscreen.js` - a `chrome.offscreen`
  document, which (unlike the service worker) doesn't get suspended when
  idle - the actual 5-second `setInterval` capture loop lives here. Does
  NOT call `chrome.tabs`/`chrome.windows` itself, despite what an earlier
  version of this file assumed - confirmed live that offscreen documents
  only have `chrome.runtime` messaging access, nothing else (a deliberate
  Chrome restriction). Instead it asks `background/service-worker.js`
  (which has full API access) to do the actual screenshotting via
  `chrome.runtime.sendMessage`, decodes what comes back to raw pixel
  data, and hands it to the sandbox below for classification. On a real
  detection, tells the service worker which tab to close.
- `background/service-worker.js` - besides Phase A's keyword sync, also
  owns the real `chrome.tabs.captureVisibleTab` calls (~2 calls/second
  real Chrome rate limit, comfortably above what a 5-second cadence needs
  even with several windows open) for the reason above, responding to the
  offscreen document's capture requests.
- `sandbox/sandbox.html` + `sandbox.js` - a manifest-declared **sandbox**
  page (relaxed CSP, no `chrome.*` API access, own opaque origin) that
  actually runs the ONNX Runtime Web session and the classifier.
  Isolated here specifically because `onnxruntime-web` tries to spawn
  real Web Workers for its thread pool, which violates Manifest V3's CSP
  even inside a plain offscreen document (multiple open
  `microsoft/onnxruntime` GitHub issues confirm this, not guessed) -
  `numThreads: 1` in `sandbox.js` also forces it away from that code path
  entirely, belt and suspenders. Preprocessing (letterbox-pad to 640x640,
  RGB float32 NCHW) and postprocessing (parsing the YOLOv8-style output,
  picking the highest-confidence blocked-class detection) are a direct
  port of `mac/ContentGuardAgent/Sources/NudeNetClassifier.swift` - same
  model, same class list, same 0.6 confidence threshold, same blocked
  classes. Kept in sync by hand; if `Config.swift`'s `blockedClasses` or
  `detectionConfidenceThreshold` ever change, `sandbox.js` needs the
  matching edit.
- `lib/ort/` - vendored `onnxruntime-web` 1.29.0 (MIT license), the
  WASM-only build (not WebGL/WebGPU) - downloaded via `npm pack`, not
  hand-written.
- `model/nudenet_640m.onnx` - a **symlink** to `mac/Model/nudenet_640m.onnx`,
  not a second copy - this repo already carries that 99MB file once;
  duplicating it would double the repo's size for no reason. This means
  the extension only works loaded from a full checkout of this repo (the
  symlink has to resolve) - it can't be zipped up as a standalone
  `chrome-extension/` folder in isolation.

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

4. **Test keyword blocking**: add a keyword via the dashboard's
   "Keyword blocker" section (takes effect immediately - no password,
   that's only needed to *remove* one). Within 5 minutes (or
   immediately, if you reload the extension from `chrome://extensions`
   to force a fresh `onInstalled`/`onStartup` sync), try navigating to a
   page whose URL or visible text contains that keyword and confirm it's
   actually blocked or the tab closes.

5. **Test NSFW detection**: open `chrome://extensions`, click the
   ContentGuard card's "service worker" link (or "Inspect views:
   service worker") to open its DevTools console - this is where every
   `console.log`/`console.warn`/`console.error` this extension emits
   shows up, since none of it is user-visible otherwise. Look for:
   - `"NudeNet ONNX session ready in sandbox"` - confirms the model
     loaded and ONNX Runtime Web actually initialized (the single
     biggest real risk in this whole build - see the CSP note below). If
     you see `"sandbox session failed to initialize"` instead, that's
     the CSP/Worker-spawning issue this design tried to route around -
     the full error message will say why.
   - Every ~5 seconds, either nothing (nothing detected, working as
     intended) or `"ContentGuard: DETECTED - class=... confidence=..."`
     followed by the tab actually closing.
   - A real, deliberately-triggered test: use any image known to trip
     an NSFW classifier and open it full-page in a tab (or make it the
     visible content of a page) - confirm detection and tab-close
     happen within about 5-10 seconds.

## Confirmed working (2026-08-25, real Mac/real Chrome)

- `onnxruntime-web` actually initializes under Manifest V3's CSP inside
  the sandboxed iframe - the real risk this whole architecture was built
  around. Console showed `"NudeNet ONNX session ready in sandbox"`.
- A real test image, opened in a tab, was caught by the classifier and
  the tab closed within the expected ~5-10 second window.
- Keyword blocking (both the URL-based `declarativeNetRequest` path and
  the page-text content-script fallback).

## Still genuinely unverified

Not blocking - the core pipeline works - but real, open questions worth
knowing about rather than assuming away:

1. **Capture quality vs. detection accuracy.** `offscreen.js`/
   `service-worker.js` request JPEG at quality 70 from
   `captureVisibleTab` (smaller/faster than PNG) - not yet confirmed
   this doesn't lose enough detail to cause real misses on borderline
   content. If detection seems to miss something a screenshot clearly
   shows, try bumping the quality value first.
2. **`declarativeNetRequest`'s `urlFilter` matching** - documented by
   Chrome as case-insensitive overall; keywords are also already
   lowercased server-side regardless, as a belt-and-suspenders measure.
3. **`chrome.alarms`' effective minimum period** for a *published/
   policy-installed* extension (vs. this unpacked dev-mode copy, which
   has looser limits) - only matters for the 5-minute keyword sync, not
   the NSFW capture loop (that one runs via a plain `setInterval` inside
   the offscreen document, with no `chrome.alarms` floor at all).
4. **Multi-window/multi-display coverage.** `service-worker.js`'s
   `captureAllWindows()` iterates every open Chrome window each tick -
   not yet tested with more than one window open at once.
