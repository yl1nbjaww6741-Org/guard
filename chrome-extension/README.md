# ContentGuard - Chrome extension

NSFW detection (5-second screenshot capture + the same NudeNet ONNX
classifier the native Mac app uses) is built AND confirmed working
end-to-end on a real Mac/real Chrome install (2026-08-25) - a real test
image was caught by the classifier and the tab closed. Getting there took
three real, live-found-and-fixed bugs (see git history / this file's own
comments in each source file): a race between the sandbox iframe's "load"
event and the model fetch, a doubled `lib/lib/ort/...` path plus a
missing vendored `.mjs` file, and offscreen documents not actually having
`chrome.tabs`/`chrome.windows` access at all (moved the real capture
calls to the service worker). None of that was guessable in advance -
real Chrome testing, each time, is what actually found and confirmed
each fix.

**Keyword blocking (URL/page-text matching against a dashboard-managed
word list) was removed once already, then re-added 2026-09-04.** The
real, self-inflicted bug that got it removed: the dashboard's Keyword
blocker section necessarily rendered every blocked keyword as plain page
text (that's the whole point of a page that lets you manage the list),
so the extension's own filter started blocking the dashboard itself the
moment a real keyword went on it. This reintroduction has that fix baked
in from the start - both enforcement paths below (the
`declarativeNetRequest` URL rule and the content script's page-text
scan) explicitly exempt the dashboard's own origin - plus an explicit
guarantee this project hadn't spelled out as deliberately before: a
keyword only ever matches as its FULL, exact phrase, never split into
individual words or matched on a prefix (a keyword like "reddit media
downloader" can never trigger on "reddit" alone). Keyword matching still
only ever catches what's on a hand-maintained word list (the NSFW image
classifier below has no such ceiling) - the two are complementary
layers, not competing ones.

## What's here

- `manifest.json` - MV3 manifest.
- `content-scripts/keyword-blocker.js` - the fallback for a keyword that
  only shows up in a page's rendered text/title, not its URL. Closes the
  tab on a match; exempts the dashboard's own origin.
- `shared/config.js` - the one hardcoded constant, `CONTENTGUARD_PANEL_URL`,
  shared between `background/service-worker.js` (via `importScripts`)
  and `content-scripts/keyword-blocker.js` (loaded first, per
  `manifest.json`'s `content_scripts` order). Replaced an options
  page (2026-09-04) that used to ask for a Worker URL and a sync token -
  `GET /sync/keywords` (extensionSync.ts, Worker side) is deliberately
  unauthenticated now, same reasoning as the self-hosted update
  endpoints below, so there's no token to configure at all: this
  extension needs zero per-machine setup after being force-installed.
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
- `background/service-worker.js` - besides keyword blocking (polls the
  Worker's `/sync/keywords` every 5 minutes, plus immediately on
  install/startup/options-save, turning the list into
  `declarativeNetRequest` rules that block matching URLs before they
  load - excluding the dashboard's own hostname from every rule, see
  that function's own comment), owns the real
  `chrome.tabs.captureVisibleTab` calls (~2 calls/second real Chrome rate
  limit, comfortably above what a 5-second cadence needs even with
  several windows open), responding to the offscreen document's capture
  requests. Also owns the offscreen document's lifecycle (creating it,
  and a periodic health-check re-creating it if Chrome ever reclaims it
  unexpectedly) and the shared close-the-tab reaction both enforcement
  paths (keyword or NSFW) use.
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

1. **Load the extension unpacked** (this hasn't been published anywhere
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

2. **Test NSFW detection**: open `chrome://extensions`, click the
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

## Battery optimizations (2026-08-25)

Ported directly from the native Mac agent's own hard-won, real-data-tuned
approach, not re-invented - same four levers, same reasoning:

1. **Pause capture entirely when there's nothing to look at**
   (`service-worker.js`'s `chromeIsFocused` + `chrome.windows.onFocusChanged`).
   Mirrors `AppScopeManager.swift`'s process-existence capture-pause
   gating - the native agent's single biggest lever. The closest
   equivalent a browser extension actually has: if Chrome isn't even the
   frontmost application (`onFocusChanged` fires with `WINDOW_ID_NONE`),
   nobody is looking at any of its content, so the whole 5-second
   capture request short-circuits to an empty result before a single
   `captureVisibleTab` call happens.
2. **Skip frames that haven't materially changed**
   (`offscreen.js`'s `perceptualHash`/`hammingDistance`, per tab). A
   verbatim port of `FrameProcessor.swift`'s own 8x8 average-luminance
   hash and hamming-distance-under-4 threshold - ported to `BigInt`
   specifically because JS's native bitwise operators coerce to 32-bit
   and would silently corrupt a 64-bit hash past bit 31.
3. **A cheap skin-tone prefilter before ever running the expensive ONNX
   classifier** (`offscreen.js`'s `skinAnalysis`). Verbatim port of
   `FrameProcessor.swift`'s YCbCr heuristic, including its two real-Mac-
   tuned thresholds (0.15 whole-thumbnail average, 0.35 densest 4x4-grid
   block) and the exact reasoning for having both: a real explicit image
   occupying only part of the screen can dilute the whole-frame average
   below threshold while still saturating one grid block - confirmed
   against synthetic test data reproducing that exact scenario before
   this was trusted. Still a load shedder, not an acquitter - failing
   this prefilter only skips a frame judged unlikely to contain the
   target classes, it never clears one; only the real classifier ever
   confirms a detection.
4. **Never move more pixels than the model can use**
   (`offscreen.js`'s single decode, reused for both the 64px prefilter
   thumbnail and the <=640px model input). Same reasoning as
   `ContentGuardConfig.maxCaptureDimension` - a Retina screenshot can be
   several times larger than the model's 640x640 input on its long side;
   downscaling once, from one decode, before the postMessage to the
   sandbox (rather than sending the full native resolution and letting
   the sandbox's own `preprocess()` do all the work) cuts both the
   message-passing payload and the sandbox's own canvas work.

Windows in a minimized state are also skipped before attempting
`captureVisibleTab` on them at all (definitionally not visible, and the
call is documented to fail on them anyway) - a smaller, more mechanical
version of the same "don't pay for work that can't matter" principle.

## Confirmed working (2026-08-25, real Mac/real Chrome)

- `onnxruntime-web` actually initializes under Manifest V3's CSP inside
  the sandboxed iframe - the real risk this whole architecture was built
  around. Console showed `"NudeNet ONNX session ready in sandbox"`.
- A real test image, opened in a tab, was caught by the classifier and
  the tab closed within the expected ~5-10 second window.

## Still genuinely unverified

Not blocking - the core pipeline works - but real, open questions worth
knowing about rather than assuming away:

1. **Capture quality vs. detection accuracy.** `offscreen.js`/
   `service-worker.js` request JPEG at quality 70 from
   `captureVisibleTab` (smaller/faster than PNG) - not yet confirmed
   this doesn't lose enough detail to cause real misses on borderline
   content. If detection seems to miss something a screenshot clearly
   shows, try bumping the quality value first.
2. **`chrome.alarms`' effective minimum period** for a *published/
   policy-installed* extension (vs. this unpacked dev-mode copy, which
   has looser limits) - only matters for the periodic offscreen-document
   health-check, not the NSFW capture loop (that one runs via a plain
   `setInterval` inside the offscreen document, with no `chrome.alarms`
   floor at all).
3. **Multi-window/multi-display coverage.** `service-worker.js`'s
   `captureAllWindows()` iterates every open Chrome window each tick -
   not yet tested with more than one window open at once.
