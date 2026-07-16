# Building ContentGuard from the command line

This project is Gradle-only - no Android Studio required. It was written and
committed from a sandboxed environment that has **no route to Google's
Maven/SDK servers** (`dl.google.com`, and `maven.google.com` which redirects
to it, are both blocked at the network-policy level there), so none of this
has actually been build-verified yet. Everything below is what you need to
do that on your own machine.

## 1. Install the Android SDK command-line tools

You need a JDK (17+; the project targets Java 17 bytecode) and the Android
command-line tools. If you don't already have an SDK installed:

```bash
# Pick an install location
export ANDROID_HOME="$HOME/Android/sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"

# Download "Command line tools only" for your OS from
# https://developer.android.com/studio#command-tools
# (this is the one URL you do need Android Studio's download page for -
# there's no versioned direct-download URL Google guarantees to keep stable)
unzip commandlinetools-*.zip -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"

export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Add the `export ANDROID_HOME=...` and `export PATH=...` lines to your shell
profile so they persist.

### Install the required packages

```bash
sdkmanager --licenses   # accept all

sdkmanager \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0"
```

That's the full set - `compileSdk 35` / `targetSdk 35` needs `platforms;android-35`
and a matching `build-tools`. `minSdk 30` doesn't need its own platform
package; only compileSdk's platform is required to build.

## 2. Build

```bash
cd guard
./gradlew assembleDebug
```

The Gradle wrapper (`gradlew`, `gradle/wrapper/*`) is already committed and
points at Gradle 8.9, which is what AGP 8.6.1 (used in the root
`build.gradle.kts`) expects. First run will download Gradle 8.9 itself plus
AGP/Kotlin/Compose/TFLite dependencies from Google's and Maven Central's
repositories - this needs a normal, unrestricted internet connection.

Output APK: `app/build/outputs/apk/debug/app-debug.apk` (package id
`com.contentguard.app.debug` - the debug build type has an
`applicationIdSuffix` so you can have both debug and release installed
side by side).

No `assets/nsfw.tflite` is shipped (see `app/src/main/assets/PLACE_MODEL_HERE.txt`),
so `assembleDebug` succeeds with `StubNsfwClassifier` active (gate 7 always
scores 0, nothing ever gets blocked, capture/inspection cascade otherwise
runs normally so you can see it working in logs).

### Signing (why updates install in place)

`app/debug.keystore` is a committed, fixed debug signing key (see
`build.gradle.kts`'s `signingConfigs`), overriding AGP's default behavior
of auto-generating a new debug keystore per machine. Without this, every
GitHub Actions run would sign the APK with a different key, and Android
refuses to install a build over a previous install signed with a
different key ("something went wrong" / `INSTALL_FAILED_UPDATE_INCOMPATIBLE`)
- forcing an uninstall first, which wipes all `SharedPreferences` (scope
mode, whitelist, threshold, lockout duration, usage stats). With every
build signed identically, `adb install -r` (or tapping a downloaded APK
again) always updates in place and every setting survives.

## 3. Install + enable, via adb

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Enable the accessibility service without tapping through the UI

```bash
adb shell settings put secure enabled_accessibility_services \
  com.contentguard.app.debug/com.contentguard.app.service.ContentGuardService

adb shell settings put secure accessibility_enabled 1
```

Caveats:
- If you already have other accessibility services enabled, the `put`
  above will **overwrite** that list, not append to it. Read the current
  value first (`adb shell settings get secure enabled_accessibility_services`)
  and construct a `:`-separated string with both entries if so.
- ColorOS has been known to reset this setting back or prompt again when it
  detects a service was enabled "outside the Settings app" - if the `adb`
  approach doesn't stick, open Settings > Accessibility > ContentGuard
  manually once; after that first manual grant it should persist across
  `adb`-driven toggles.
- For the release build (no `.debug` suffix), use
  `com.contentguard.app/com.contentguard.app.service.ContentGuardService`.

### Force-stop / uninstall protection (Device Admin)

The Settings screen has an "Enable Protection" button under "Force-stop /
uninstall protection is OFF" that walks you through Android's own Device
Admin activation dialog - no adb step needed. This is regular Device Admin
(`DeviceAdminReceiver`), not Device Owner: no factory reset or MDM
enrollment required, and it's fully revocable at any time from Settings >
Security > Device admin apps.

Simply being an active administrator is what makes Android grey out
"Force stop" and "Uninstall" for this app system-wide (in Settings > Apps
and in the battery/app-info screens) - that protection comes from admin
status itself, not from any specific policy requested in
`device_admin_receiver.xml` (which deliberately requests none). Turning
it off requires deactivating device admin first, same as any other app
using this mechanism (this is also how most third-party parental-control
/ app-blocker apps achieve the same behavior).

### N-strikes lockout

The Settings screen has an "N-strikes lockout" card: an adjustable number
of `GATE8_BLOCK` hits (default 3, slider up to 20 - raise it for a longer
test session without tripping a real lockout) for the *same app* within a
rolling 15-minute window locks just that app (not the whole device) for
an adjustable duration (default 1 minute, slider up to 30). While locked
out, the cascade skips straight past gate 1 for that package - no
screenshot or inference runs - and switching back into the app re-shows
the fake-crash block immediately rather than waiting for a fresh
detection. Strikes and lockout state are tracked per-package in
`PrefsRepository` (`recordExplicitStrike`/`isLockedOut`); the strike count
itself is `strikesToLockout`.

### App password + Accessibility/Device Admin screen guard

The Settings screen has an "App password" card. Once set, it gates:

1. **ContentGuard's own Settings screen** - reopening it prompts for the
   password before showing anything (`SettingsActivity`'s `PasswordUnlockScreen`).
2. **The system "Accessibility" and "Device admin apps" screens** -
   `ContentGuardService` checks the *window title* (from the
   `TYPE_WINDOW_STATE_CHANGED` event's own `text`, not a scan of all
   on-screen content) whenever `com.android.settings` is foreground, and
   if it matches, shows a full-screen password prompt
   (`PasswordGuardOverlayController`) before the real screen becomes
   usable - wrong password or cancel performs `GLOBAL_ACTION_HOME`.
   Deliberately keyed on the window title rather than a full text scan:
   an earlier version scanned all visible text and matched "Device admin
   apps" wherever it appeared, including as a search-suggestion chip on
   Settings' own search screen, which isn't the real screen at all and
   shouldn't trigger anything. Without this guard, opening either real
   screen and disabling the service/admin from system Settings would
   undo ContentGuard's protections with zero friction. The unlock
   persists until you leave the Settings app entirely, not per-screen.

No password set means both are open exactly as before - this is opt-in.
Stored as a salted SHA-256 hash in `PrefsRepository`, never the raw text.

### Gate 3 (image detection) also catches Compose-rendered content

`NodeInspector` originally only flagged a node as "image-like" by className
substring match (`ImageView`, `WebView`, `SurfaceView`, `TextureView`,
`VideoView`). Real-world testing found this missed actual explicit content
on Reddit's app, which is largely built with Jetpack Compose - Compose
doesn't expose those classic View class names in its accessibility tree at
all, so the whole cascade was exiting at `GATE3_NO_IMAGE_NODES` before ever
taking a screenshot. Gate 3 now also flags any large, childless, textless
node as image-like regardless of class name, which catches Compose-rendered
images/media generically. This trades a few extra screenshots on plain
screens (gates 6/7 still filter those out as safe) for not silently missing
real content - the right side to err on for what this app is for.

### Static content now gets caught, not just events

The cascade only ran when an `AccessibilityEvent` fired (scroll, content
change, app switch) - a user static on an already-rendered image generated
no further events at all, so real content could sit on screen indefinitely
without ever being re-scanned. `ContentGuardService.recheckStaticContent()`
now periodically (every 2s) re-queues a frame for whatever app is currently
foreground, independent of events. The frame channel is CONFLATED and
`ScreenCapturer` has its own throttle, so redundant ticks are cheap - they
just exit at `GATE5_CAPTURE_THROTTLED_OR_FAILED` when a real event already
triggered a capture recently.

### Gates 6/7 now analyze the image region, at native resolution

Real-world testing found explicit Reddit feed thumbnails weren't blocking
until the user opened the photo full-screen (or zoomed in). Two compounding
causes, found in two passes:

1. Gate 6's skin-tone check (and gate 7's classifier) ran on the *whole*
   screenshot - a feed thumbnail is a small fraction of a screen that's
   mostly text/white background/other posts, so its skin-tone ratio got
   diluted well under gate 6's 10% threshold.
2. Even after cropping to the detected image region, thumbnails still
   weren't reliably blocking - because that first crop happened *after*
   `ScreenCapturer` had already downscaled the whole frame to 640px. A
   small region cropped out of an already-downscaled frame is
   low-resolution twice over, which is exactly why zooming in (capturing
   the same content at genuinely higher native resolution) worked while
   standing still on the feed didn't.

Fixed by cropping at capture time instead: `ScreenCapturer.captureDownscaled()`
now takes an optional `cropRegion` (real screen pixel coordinates, same
space as `AccessibilityNodeInfo` bounds) applied to the *native-resolution*
screenshot before any downscaling, so a small region stays near its real
resolution instead of being squeezed through a low-res intermediate step.
`processFrame` passes the union of `NodeInspector`'s detected image bounds
as that crop region. Falls back to the full frame if there's nothing to
crop to. Known remaining limitation: a feed with several separate
thumbnails visible at once still unions across all of them rather than
checking each individually - flag it if misses persist in dense
list/compact feed views specifically.

### Gate 3 decoupled: permissive capture trigger vs strict crop region

A third real miss, found scrolling Reddit's feed: `GATE3_NO_IMAGE_NODES`
fired on essentially every frame, even though feed cards clearly have
thumbnails. Cause: Reddit's Compose UI likely uses accessibility semantics
merging (`mergeDescendants`), which collapses an image thumbnail and its
post title/metadata into a single node - that merged node has real visual
content but also carries its own text, failing the existing "childless and
no text" heuristic (added for the earlier Compose-detection fix) outright.
`NodeInspector` now tracks two separate signals instead of one:
`hasImages` (whether to bother capturing at all) is permissive - any node
at least 150x150px counts, regardless of children or text, since a node
that large is almost certainly real content. `imageBounds` (fed into
`ScreenCapturer`'s crop region) stays on the stricter heuristic, since
loosening that one would make the crop degenerate back to nearly the
whole screen. When a merged node trips `hasImages` but isn't specific
enough to produce real `imageBounds`, capture falls back to the whole
frame rather than skipping entirely - a real capture without an optimal
crop beats no capture at all.

### Keyboard opening/closing was hijacking the "foreground app" tracker

Real-world testing found a user could sit on a static explicit image
indefinitely with no block, then have it block instantly on the slightest
interaction. Cause: the on-screen keyboard (IME) fires its own
`TYPE_WINDOW_STATE_CHANGED` event with its own package
(`com.google.android.inputmethod.latin`) whenever it opens or closes.
`onAccessibilityEvent` treated any window-state-change to a different
package as a real app switch, so this event overwrote
`lastForegroundPackage` with the keyboard's package - meaning the periodic
static-content recheck (see above) then spent seconds re-querying the
*keyboard* instead of whatever app and image were actually still on
screen underneath it. Real app activities report as
`AccessibilityWindowInfo.TYPE_APPLICATION`; the IME (and other system/
overlay windows) don't - `onAccessibilityEvent` now checks this via the
service's own `windows` list and ignores window-state-change events from
non-application windows entirely, so they can no longer overwrite what
the cascade thinks is foreground.

### The launcher app is now visible in the Apps list

The Apps list in Settings was built from `queryIntentActivities()` against
`ACTION_MAIN` + `CATEGORY_LAUNCHER` - the intent apps register to show up
in the app drawer. The home/launcher app itself doesn't have its own
app-drawer icon; it registers under `CATEGORY_HOME` instead, so it never
appeared in the list at all - meaning it couldn't be found or whitelisted,
even though it was still being monitored/screenshotted like any other app
under "Monitor all except whitelisted" (confirmed via real logs showing
`com.android.launcher` reaching gates 6/7 repeatedly). `loadLaunchableApps()`
now also queries `CATEGORY_HOME` and merges the results (deduped by
package name); `AndroidManifest.xml`'s `<queries>` block had to declare
that intent too, or Android 11+ package visibility rules would silently
filter it back out even with the code change.

### Static-content recheck now queries live state, not a cached variable

A second, related instance of the IME hijacking bug: this time
`com.android.launcher` itself hijacked `lastForegroundPackage` for 4+
seconds while the user was still looking at a static Reddit photo - likely
a partial gesture-navigation swipe briefly showing the home screen behind
the current app. The launcher's window is a genuine `TYPE_APPLICATION`
window, so the earlier IME-specific fix (checking window type) didn't
catch this. Rather than special-case every possible spurious source,
`recheckStaticContent()` now queries `rootInActiveWindow` fresh on every
2s tick instead of trusting the event-driven `lastForegroundPackage`
field - asking the OS what's actually active right now sidesteps this
whole class of bug rather than enumerating causes one at a time.

### Tuned for detection speed over battery, per explicit request

Three timing constants were lowered together to minimize first-detection
latency, trading away some of the battery savings they were originally
tuned for:

- `ScreenCapturer.THROTTLE_FLOOR_MS`: 1500ms -> 900ms - back down to just
  under the platform's own screenshot rate limit
  (`ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT`, roughly one call/second).
  Going lower than ~900ms buys nothing - the OS itself starts rejecting
  calls at that point.
- `ContentGuardService.STATIC_RECHECK_INTERVAL_MS`: 2000ms -> 1000ms - the
  periodic static-content fallback now fires twice as often, staying just
  above the new capture floor.
- `EventDebouncer.settleWindowMs`: 250ms -> 100ms - less delay between
  processing successive content-change events during scrolling.

Net effect: best-case first-detection latency drops from ~300-600ms to
roughly the same range but hit far more often (worst-case gap shrinks
from ~2s to ~1s), at a real, deliberate battery cost.

### Block dismissal now goes back *and* home

Tapping "OK" on the fake-crash dialog (or pressing back, if "Auto-dismiss
on block" is on) now performs `GLOBAL_ACTION_BACK` followed by
`GLOBAL_ACTION_HOME`, not just back - back alone could still leave you
inside the same app on a different screen; home guarantees you land on
the home screen instead.

### Watching the cascade

```bash
adb logcat -s ContentGuardService ScreenCapturer NsfwClassifierFactory BlurOverlayController
```

Every processed event logs exactly one `exit@GATE...` line (see
`ContentGuardService.processFrame`), so you can see precisely how far each
screen got through the cascade - `GATE1_WHITELIST` / `GATE2_DEBOUNCE` mean
gate 1/2 stopped it, `GATE8_BLOCK` means it was blocked, etc.

## 4. Dropping in the real model

Put your quantized classifier at `app/src/main/assets/nsfw.tflite`. See
`app/src/main/assets/PLACE_MODEL_HERE.txt` for the exact input/output
contract `TFLiteNsfwClassifier` expects. Nothing else needs to change -
`NsfwClassifierFactory` picks it up automatically on next build/install.

Recommended source model and exact conversion steps (all run on your own
machine - none of this works in a sandbox without normal internet access):

1. Download the MobileNetV2 variant from
   [GantMan/nsfw_model](https://github.com/GantMan/nsfw_model) (MIT
   licensed) releases page - either a `.h5` file or a SavedModel directory.
2. `pip install tensorflow pillow numpy`, then convert - no quantization
   to start with, so no representative-images folder needed yet:
   ```bash
   python tools/convert_nsfw_model.py \
     --model /path/to/downloaded/model \
     --output app/src/main/assets/nsfw.tflite
   ```
   This gets you a plain float32 model - bigger and slower per inference
   than a quantized one, but proves the whole pipeline (class taxonomy,
   thresholding, cascade wiring) actually works before optimizing it.
   Once that's confirmed, re-run with `--quantize dynamic` (still no
   representative images, smaller/faster) or `--quantize int8` (needs a
   ~100-500 image representative-images folder, smallest/fastest) - see
   `tools/convert_nsfw_model.py --help` for all three modes.
3. Rebuild (`git push` to trigger CI, or `./gradlew assembleDebug` locally)
   and reinstall.
4. **Calibrate before trusting it**: this model is a 5-class softmax
   (drawings/hentai/neutral/porn/sexy), not a single NSFW score.
   `TFLiteNsfwClassifier`'s `unsafeClassIndices` (default: hentai+porn+sexy)
   decides what counts as "unsafe," and `nsfwThreshold` in the app's
   settings decides how confident it needs to be. Test with your own
   sample images spanning clearly-SFW, swimwear/underwear, explicit, and
   hentai content before relying on the defaults - the "sexy" class
   (index 4) in particular is a judgment call: it's included by default,
   so swimwear/lingerie gets blocked too; drop it from
   `DEFAULT_UNSAFE_CLASS_INDICES` in `TFLiteNsfwClassifier.kt` if you only
   want explicit content (hentai+porn) blocked.

## 5. SigLIP2 model - separating "sexy" from real nudity (live, gate 7 default)

GantMan's model and the older ONNX ViT model (`assets/nsfw.onnx`) both
either lack a "suggestive but not explicit" class or fold it into NSFW.
`prithivMLmods/siglip2-mini-explicit-content` has 5 classes (Anime
Picture, Enticing & Sensual, Hentai, Pornography, Safe for Work) that
separate "sensual" from actual porn/hentai - closer to "only block real
nudity." This went through 3 stages, all now complete:

1. **Export + quantize** (`tools/export_siglip_onnx.py`, run on your own
   machine - needs Hugging Face access this project's sandbox doesn't
   have: `pip install torch transformers onnx onnxruntime`, then just run
   the script). Confirmed input size 224x224, mean/std (0.5, 0.5, 0.5) -
   both read off the model's own processor config, not assumed. Uses
   `dynamo=False` in the `torch.onnx.export()` call - the default
   TorchDynamo-based exporter produces a graph that trips a real bug in
   onnxruntime's quantizer (`ONNXQuantizer.__init__` unconditionally calls
   `replace_gemm_with_matmul()`, which leaves a stale shape annotation on
   the classifier head's Gemm node); the legacy tracer avoids it. Produces
   `siglip2_mini_explicit.onnx` (fp32, 328MB) and
   `siglip2_mini_explicit_int8.onnx` (dynamic QUInt8, 83MB) - both
   committed under `models/` for reference.
2. **NNAPI engagement spike** - confirmed on a real Find X9 Pro:
   `executionProvider=NNAPI`, avg 148ms/inference. Two ways to re-check
   this on any device: the throwaway instrumented test
   (`app/src/androidTest/kotlin/com/contentguard/app/NnapiEngagementSpikeTest.kt`,
   via `./gradlew connectedAndroidTest`), or the "Run NNAPI Spike
   (SigLIP2)" debug button at the bottom of the Settings screen in a
   normal installed debug APK (`SiglipNnapiSpike.kt`) - the latter is
   easier since it needs no test harness, just an installed APK and
   logcat (`adb logcat -s SiglipNnapiSpike`).
3. **Full integration**: `SiglipNsfwClassifier.kt` implements the same
   `NsfwClassifier` interface as every other gate-7 backend. Preprocessing
   reuses `ViTPreprocessor` (identical mean/std convention, different
   confirmed size). `NsfwClassifierFactory` now prefers
   `assets/siglip2_nsfw.onnx` over the legacy `nsfw.onnx`/`nsfw.tflite`,
   which still work as fallbacks if this model fails to load.

   Per-class thresholds decide what actually blocks -
   `SiglipNsfwClassifier.DEFAULT_CLASS_POLICIES` blocks **Pornography,
   Hentai (0.45 each), and Enticing & Sensual (0.6)**. Enticing & Sensual
   was briefly removed on the theory that it only meant "sexy but not
   explicit," but real-world testing contradicted that: confirmed
   full-nudity content scored ~98-99% Enticing & Sensual and under 3%
   Pornography in the same frames - this model's own taxonomy evidently
   classifies plain nudity under Enticing & Sensual and reserves
   Pornography for more explicit sexual acts specifically, so it's back
   and is in fact the operative "real nudity" signal, not a separate
   "also block sexy content" add-on. Its threshold bounced 0.6 -> 0.7 ->
   back to 0.6: 0.7 avoided a gym-clothes false positive (0.676) but then
   missed real borderline nudity scoring 0.59-0.60 in later testing.
   There's a genuine overlap zone in this model's own scoring between
   "athletic wear" and "borderline/partially-visible nudity" - roughly
   0.59-0.68 - that no single threshold on this axis alone perfectly
   separates; 0.6 lands back on the side of catching more real nudity at
   the cost of occasional gym/athletic-wear false positives. Safe for
   Work and Anime Picture are
   logged on every inference (`adb logcat -s SiglipNsfwClassifier`, tag
   `class=... prob=...`) but never block. `scoreNsfw()` returns
   `max(classProb / classThreshold)` across the configured classes - a
   ratio >= 1.0 means some class's own threshold was met, which always
   trips the app's existing global `nsfwThreshold` slider (it tops out at
   1.0) regardless of where you've set it; below 1.0 it scales with how
   close the closest configured class got.

## ColorOS / OPPO Find X9 Pro notes

See [`docs/COLOROS.md`](docs/COLOROS.md) for battery-optimization exemption,
Super Power Saving mode, and rebind guidance specific to this device.
