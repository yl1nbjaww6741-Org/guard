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

### Getting a build without building it yourself

Every push to `main` triggers `.github/workflows/build.yml`, which builds
the debug APK and publishes it to a single rolling GitHub Release tagged
`latest-debug` (repo's Releases page) - not an Actions artifact. Actions
artifacts are billed against a separate, small per-account storage quota
that filled up fast under this project's push cadence
("Failed to CreateArtifact: Artifact storage quota has been hit", which
only clears on GitHub's own 6-12 hour recalculation cycle, not by deleting
old runs or waiting a few minutes); release assets use the repo's normal
storage instead, so this doesn't recur. The release's single APK asset is
overwritten (`gh release upload ... --clobber`) on every run rather than
creating a new release per push, so there's one stable URL to bookmark
instead of a growing list.

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

### Downgrade protection

The fixed signing key above is what makes in-place updates possible at
all - but it also means a saved older APK (e.g. one built before some
protection was tightened) installs over the current one just as easily as
a newer one does, unless something stops it. Android's own installer
already refuses this (`INSTALL_FAILED_VERSION_DOWNGRADE`) whenever the new
APK's `versionCode` is lower than the installed one - but `versionCode`
was a static `1` on every build, so every APK this project ever produced
compared *equal*, not lower, and the check never actually fired. `app/build.gradle.kts`
now derives `versionCode` from build time (minutes since a fixed epoch)
instead, so each build is guaranteed strictly newer than the last and the
stock downgrade check finally has something to act on. This only blocks
the normal tap-to-install/`adb install -r` path - `adb install -d`
(explicit allow-downgrade) can still force it, but that needs USB
debugging enabled plus a connected computer, a materially higher-effort
bypass than resurfacing a saved APK file.

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

### Accessibility watchdog (survives ColorOS "Hide apps")

Confirmed via direct testing: using ColorOS's own "Hide apps" feature on
ContentGuard silently strips it out of `enabled_accessibility_services`
(same mechanism, in reverse, as the enable command above) - turning off
the whole cascade with no warning. `AccessibilityWatchdogService` (see
`docs/COLOROS.md` section 4 and the class's own doc comment) watches for
exactly this and restores it automatically, the same way MacroDroid was
confirmed to survive the identical action on the same device. This needs
one more one-time grant, same pattern as enabling accessibility itself:

```bash
adb shell pm grant com.contentguard.app.debug android.permission.WRITE_SECURE_SETTINGS
```

(drop `.debug` for the release build, same as above). Without this grant,
the watchdog fails closed - it logs a warning and does nothing, rather
than crashing - so the rest of the app works normally either way; this
permission only affects whether "Hide apps" specifically gets undone
automatically.

Deliberately no way to turn this back off from within the app once
granted - same reasoning as the password-gated Settings/Accessibility
screens elsewhere in this project. If you ever need to genuinely disable
ContentGuard's accessibility (not just hide the app), stop
`AccessibilityWatchdogService` itself first
(`adb shell am stopservice com.contentguard.app.debug/com.contentguard.app.service.AccessibilityWatchdogService`),
or it will just restore the setting again on its next check.

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

On the specific strike that trips the lockout, `ContentGuardService` does
more than just show the block overlay: it navigates home immediately
(`GLOBAL_ACTION_HOME`, not waiting for the user to dismiss the fake-crash
dialog first) and then calls `ActivityManager.killBackgroundProcesses()`
on the offending package, so switching back to it via Recents finds a cold
start instead of resuming exactly where it was left. This only needs the
normal, install-time-granted `KILL_BACKGROUND_PROCESSES` permission - no
adb/root/Shizuku required - but it's documented by Android as a hint the
OS can decline, not a guaranteed kill the way Settings' own "Force Stop"
button is (that uses a signature-protected API third-party apps can't
call even with Shizuku's shell-level access). Every other (non-lockout)
block still just shows the overlay on dismissal, same as before.

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

### Hidden/system packages and input methods are now visible in the Apps list too

Prompted directly by the Gboard false-monitoring bug above: even after
fixing the underlying cascade bug, there was still no way to *find*
`com.google.android.inputmethod.latin` (or any other package with no
launcher icon) in Settings to whitelist it as a belt-and-suspenders
measure - `loadLaunchableApps()` only ever queried `CATEGORY_LAUNCHER` +
`CATEGORY_HOME`, which by definition excludes input methods, background
services, and other OEM system packages.

`loadLaunchableApps()` now calls `PackageManager.getInstalledApplications()`
instead, returning every installed package regardless of launcher
visibility, tagged in the Apps list as "Input method" (cross-referenced
against `InputMethodManager.getInputMethodList()`) or "Hidden" (no
launcher/home intent) so they're easy to distinguish from ordinary apps.
Requires the `QUERY_ALL_PACKAGES` permission - Play Store restricts that
permission's use, but doesn't apply here since this app is only ever
sideloaded (see section 2's "Getting a build without building it
yourself"), never submitted to Play. A full unfiltered list of every
installed package can run into the hundreds once hidden/system ones are
included, so a search box was added above the (still collapsed-by-default)
list, filtering by label or package name - without it, finding one
specific package in that list would mean scrolling through all of them.

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

### Doubled back up for battery once detection became reliable

Once the pixel-based skin-region crop (`SkinTonePrefilter.analyze()`)
made per-frame detection reliable, the calculus above flipped: a slower
capture cadence now only costs latency, not whether explicit content gets
caught, since the classifier reliably catches it whenever it does get a
look. `ScreenCapturer.THROTTLE_FLOOR_MS` doubled 900ms -> 1800ms and
`ContentGuardService.STATIC_RECHECK_INTERVAL_MS` doubled 1000ms -> 2000ms
together, roughly halving capture+inference frequency for a real battery
win, at the cost of up to ~2s (from ~1s) before a fresh capture happens.
`EventDebouncer.settleWindowMs` (100ms) was left as-is - it wasn't part
of this specific trade.

### Static recheck now skips entirely while the screen is off

A full code review looking for battery opportunities found that
`recheckStaticContent()`'s 2-second timer loop had no check for whether
the screen was even on. `onAccessibilityEvent` is naturally quiet with the
screen off (no window-state changes occur), but this loop is timer-driven
and kept firing regardless - and accessibility services aren't Doze-
throttled the way ordinary apps are, so this ran on schedule 24/7,
including screen-off stretches (pocket, overnight charging), each tick
querying `rootInActiveWindow` and, since `rootInActiveWindow` can still
report the last-foreground app after the screen turns off, often actually
attempting a real screenshot capture and inference - the two most
expensive operations in the app - for a screen nobody could be looking at.

Unlike every other capture/interval trade in this section, this one is a
pure win, not a latency-vs-battery trade: a screen that's off has nothing
visible to detect, so there's no detection downside to skipping. Fixed
with a single `PowerManager.isInteractive` check at the top of the loop
body, before any capture is attempted - `ScreenCapturer`'s own 1800ms
throttle doesn't cover this case, since it's shorter than this loop's own
2000ms interval and so wouldn't actually suppress a screen-off capture
attempt the way it suppresses genuinely redundant same-second ticks while
the screen is in use.

### Static recheck was also missing the IME-window check the event path already had

A third instance of the IME-hijacking bug class (see "Keyboard opening/
closing was hijacking the 'foreground app' tracker" above), found from
real device logs: `com.google.android.inputmethod.latin` (Gboard) reaching
gates 5/6 repeatedly - `exit@GATE6_NO_SKIN_TONE` every ~2s - purely from
typing, with no monitored app ever opened. `onAccessibilityEvent` already
guards against IME windows via `isApplicationWindow(event.windowId)`, but
`recheckStaticContent()`'s direct `rootInActiveWindow` query never applied
that same check - and an IME window can genuinely become "the active
window" while it has input focus, not just via a spurious event, so this
wasn't just a redundant safety net. Fixed by applying the identical
`isApplicationWindow` check to this loop's `root.windowId` before
capture/scoring can happen at all.

### WebView was polluting the crop region in browsers

Real-world testing found explicit content in Chrome consistently scoring
low ("Safe for Work" dominating) while swiping through a page, but
blocking immediately on the slightest zoom - the opposite pattern from a
missed detection, and a strong signal the crop region itself was wrong
rather than the classifier being wrong. Cause: `IMAGE_CLASS_HINTS`
included `"WebView"`, which feeds the *strict* crop-region calculation
(`imageBounds`), not just the permissive "should we bother capturing"
check. Chrome renders an entire page inside one large `WebView`-classed
node spanning nearly the whole screen, so the crop region degenerated to
"the whole page" - diluting one specific photo among surrounding page
content, same as the earlier Reddit-feed dilution bug, except here the
crop mechanism couldn't help at all, because the "image" it found *was*
the whole page. Zooming in worked because the photo then fills the whole
WebView, making crop-to-page and crop-to-photo coincide by accident.
`WebView` removed from `IMAGE_CLASS_HINTS` entirely - gate 3's permissive
`hasSubstantialContent` check still triggers on browser content
regardless (a WebView's sheer size guarantees that), so this only
affects crop precision, not whether capture happens at all. Not fully
verified whether Chrome exposes individual DOM image elements to
`NodeInspector` in a form the remaining heuristics can target - if not,
capture falls back to the whole frame (same dilution risk, minus the
false confidence of a mislabeled "targeted" crop) - worth retesting to
confirm.

### Gate 6 now finds *where* skin is, not just *whether*, pixel-based

Real-world screenshots confirmed the root cause behind persistent misses
on both native Reddit and Chrome: a photo post's actual explicit content
typically occupies under half the screen, surrounded by real UI chrome
(header/toolbar, username/NSFW tag/title text, vote/comment buttons,
even the next post already peeking in) - sometimes with black
letterboxing bars around the photo itself on top of that. This dilutes
classifier confidence the same way regardless of whether the surrounding
app is native Compose (Reddit) or a rendered webpage (Chrome), and
accessibility-tree-based cropping (`NodeInspector`/`ScreenCapturer`'s
`cropRegion`) can't be made reliable across every framework - Reddit's
semantics-merging and Chrome's DOM/CSS rendering are two unrelated
reasons precise bounds aren't always available.

Rather than keep chasing framework-specific accessibility quirks,
`SkinTonePrefilter.analyze()` now buckets the captured frame into an 8x8
grid and returns the bounding region of wherever skin-toned pixels are
actually concentrated, not just a global yes/no ratio. `processFrame`
crops to that region (on top of whatever accessibility-based crop, if
any, already applied) before running the classifier. This works
identically no matter what drew the pixels, since it never touches the
accessibility tree at all - a real, pixel-level view of where the
explicit content actually is.

### Block dismissal goes back twice, then home

Tapping "OK" on the fake-crash dialog (or pressing back, if "Auto-dismiss
on block" is on) performs `GLOBAL_ACTION_BACK` **twice** (200ms apart, so
each transition actually finishes before the next fires) followed by
`GLOBAL_ACTION_HOME` (`ContentGuardService.dismissBlockedApp()`). One back
press alone often only closes an in-app photo/video viewer without
leaving the app itself - which meant Recents' task-switcher thumbnail for
that app could still show whatever explicit content was last rendered
right before the overlay went up, even though the overlay itself was
gone. Two back presses plus home closes that gap.

### Watching the cascade

```bash
adb logcat -s ContentGuardService ScreenCapturer NsfwClassifierFactory NudeNetDetector BlurOverlayController
```

Every processed event logs exactly one `exit@GATE...` line (see
`ContentGuardService.processFrame`), so you can see precisely how far each
screen got through the cascade - `GATE1_WHITELIST` / `GATE2_DEBOUNCE` mean
gate 1/2 stopped it, `GATE8_BLOCK` means it was blocked, etc.

### Gate 4: private/incognito browsing is blocked outright, browser-agnostic

Browsers set `FLAG_SECURE` on private/incognito windows specifically to
block screenshots and screen recording - which also blocks
`AccessibilityService.takeScreenshot()` (what `ScreenCapturer` uses) with
no exception for accessibility services. That means gates 5-7 (capture,
skin-tone prefilter, NN classifier) structurally cannot see into a private
tab at all, on any browser, ever - no amount of retuning fixes that,
because the classifier never gets a frame to look at.

`IncognitoDetector.kt` sidesteps this by detecting *presence* instead of
inspecting content, via two signals, both restricted to
`IncognitoDetector.BROWSER_PACKAGES`:

- **Title check (primary)**: `onAccessibilityEvent` matches
  `TITLE_KEYWORDS` against the window's own title on a
  `TYPE_WINDOW_STATE_CHANGED` event - confirmed against real on-device
  titles (Chrome): a regular tab reports `"Chrome: New tab"` (no match), an
  incognito tab reports `"Chrome: New Incognito tab"` (matches). Logs
  `GATE4_INCOGNITO_DETECTED title="..."` and blocks immediately.
- **Content fallback**: `processFrame()` matches the narrower
  `CONTENT_KEYWORDS` against `NodeInspector.scan().visibleText` (the same
  tree scan gate 3 already does every frame, restricted to nodes
  `isVisibleToUser()` reports as actually on screen - see point 3 below),
  for cases where the title alone didn't carry the signal. Logs
  `GATE4_INCOGNITO_DETECTED content keyword="..."`, naming the specific
  keyword that matched.

Both block with the same overlay as a real `GATE8_BLOCK` - same
persist-until-dismiss-or-app-switch behavior, no new UI.

**Real-world testing found two rounds of false positives before landing
here, both instructive:**

1. The first version checked every app (not just browsers) and matched a
   bare `"incognito"` against the *entire* accessibility tree's
   concatenated text - fired on ordinary Chrome browsing and on Gboard,
   which genuinely shows its own "Incognito mode" privacy indicator
   whenever the field it's typing into is flagged private (in any app),
   and this codebase has hit the general "the IME's own window briefly
   looks like the foreground package" bug class before. Fixed by
   restricting both checks to `BROWSER_PACKAGES`, and splitting
   `TITLE_KEYWORDS` (safe to include the bare word - a single short
   string, no concatenation risk) from a narrower `CONTENT_KEYWORDS`
   (multi-word phrases only, since Chrome's tab-switcher button reports an
   incognito tab *count* in its content description even at zero, so the
   bare word was present in the tree on ordinary pages too).
2. With those fixed, the *title* check then appeared to fire on every
   Chrome tab in one round of testing - but on-device logging
   (`GATE4_TITLE_DEBUG`, added specifically to check this rather than
   guess again) showed the title field is in fact clean and correct
   (`"Chrome: New tab"` vs. `"Chrome: New Incognito tab"`); that particular
   report was almost certainly an incognito tab left open from testing the
   previous fix, not a real false positive.
3. Even with the title logic confirmed correct in isolation, Chrome kept
   coming back fully blocked on real-device retesting, and the actual
   cause wasn't root-caused at the time - something about Chrome
   specifically was still misfiring somewhere beyond what
   `GATE4_TITLE_DEBUG` checked. Chrome's package IDs were temporarily
   commented out of `IncognitoDetector.BROWSER_PACKAGES` so normal Chrome
   use wasn't broken in the meantime.

   **Root cause, found on a later pass**: `NodeInspector.scan()`'s
   `visibleText` - despite the name - never actually checked
   `isVisibleToUser()`. It walked and concatenated text/contentDescription
   from *every* node reachable from the root, including anything off-screen
   or sitting in a collapsed/hidden panel, not just what was actually
   showing. The content-based check (unlike the title check) also ran
   continuously - every real event plus every 2s static-content recheck -
   with no debug logging of *which* keyword matched, so a stray
   `CONTENT_KEYWORDS` match anywhere in Chrome's tree had both a much wider
   surface to fire on and no way to diagnose it when it did. Fixed by (1)
   gating `NodeInspector`'s text collection on `isVisibleToUser()`, and (2)
   `IncognitoDetector.matchingContentKeyword()` now surfacing which keyword
   matched in the `GATE4_INCOGNITO_DETECTED content keyword="..."` log line.
   Chrome's package IDs are back in `BROWSER_PACKAGES` on that basis - if
   this recurs, the log now says which keyword fired instead of leaving
   another unexplained report to re-investigate from scratch.

Deliberately no Settings toggle to disable this - the point is that
private browsing can't be used to evade the rest of the cascade, so it
shouldn't have an easy in-app off switch any more than the password-gated
Settings/Accessibility screens do. Not wired into the N-strikes/lockout
counters or usage stats - it's an independent block, not treated as an
explicit-content strike.

### Gate 4b: keyword-based search blocking, on search intent not page content

`KeywordBlocklist.kt` blocks a browser outright the moment an explicit
search term is typed into an address bar or search box, before any page
or image ever loads - same placement in `processFrame` as gate 4 above,
checked before GATE3's image-content check, for the same reason: this
should block regardless of whether an image is even on screen yet.

Deliberately matches against a *new*, narrower text source -
`NodeScanResult.inputFieldText` - rather than reusing gate 4's
`visibleText` whole-page scan. `NodeInspector.scan()` now also collects
text from nodes where `isEditable` is true (the framework's own signal for
"this is a text input," not a className guess - works the same regardless
of which concrete widget class a given browser uses for its address bar),
kept in a separate field from the general page-text scan. Matching against
the whole page instead would catch far more than intended: health/biology
articles, sex-ed material, and ordinary news coverage all legitimately
contain many of these words, and gate 4 already hit exactly this failure
mode once (see above) before its root cause was found. A rendered
WebView's page body is never exposed as an editable node's own text, so
restricting to `inputFieldText` keeps this to what's actually being
searched for.

`KeywordBlocklist.EXPLICIT_KEYWORDS` favors high-precision terms - known
adult platform names (`pornhub`, `xvideos`, etc. - unambiguous by
themselves) and explicit-content genre phrases (`"xxx video"`, `"nude
pics"`, ...) - over bare anatomical terms, which show up constantly in
ordinary non-adult contexts and would make even this narrower scope noisy.
Not exhaustive by design - a starting set of the terms someone would
actually type to search for adult content, easy to extend later based on
real `GATE4B_KEYWORD_BLOCKED keyword="..."` log activity, the same
diagnose-from-logs pattern gate 4 now follows.

Restricted to `IncognitoDetector.BROWSER_PACKAGES` (same set gate 4 uses).
No dedicated on/off Settings toggle, same reasoning as gate 4 - but unlike
gate 4, the keyword list itself is editable: `PrefsRepository.getExplicitKeywords()`
starts from `KeywordBlocklist.EXPLICIT_KEYWORDS` until customized, at which
point the stored set replaces the default rather than layering on top of
it. The Settings screen's "Explicit search keywords" card (password-gated,
same as every other Settings card) lets the developer add/remove terms and
reset back to the built-in list. This is a real, accepted trade-off -
clearing every keyword functionally disables the gate, the same way
setting the NSFW threshold to 1.0 already can for gates 6/7 - kept
editable anyway because a fixed, unreviewable list can't be tuned for
false positives/negatives actually observed on a real device.

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

## 5. NudeNet 320n - detection instead of classification (live, gate 7 default)

Gate 7 previously ran `prithivMLmods/siglip2-mini-explicit-content`, a
whole-image 5-class classifier. That was replaced because the underlying
problem was **taxonomy, not model quality**: a whole-image classifier makes
one global judgement, and "gym clothes" vs. real nudity share the same
dominant visual signal (skin area + body shape) - no amount of threshold
tuning on a single scalar score reliably separates them.

`notAI-tech/NudeNet` v3's `320n` model is a body-part **detector**
(YOLOv8-family, ~7MB ONNX, bundled directly in the `nudenet` PyPI wheel -
no external download needed) instead of a whole-image classifier. Exposed
vs. covered is encoded directly in its 18-label set (e.g. gym clothes -> a
`*_COVERED` label -> never blocks), so the safe/unsafe distinction is a
rule over labels, not a tuned threshold over one global score.

### Model + runtime

- **Asset**: `app/src/main/assets/320n.onnx`, extracted as-is from the
  `nudenet` PyPI package (`pip download nudenet --no-deps`, unzip the
  wheel, the model is at `nudenet/320n.onnx`). **FP32, not quantized** -
  INT8 would need a static calibration dataset made of exactly the content
  this app exists to avoid collecting, and quantization degrades
  small-object recall worst, which is already this model's weakest point
  (see "Known limitation" below).
- **Execution provider**: XNNPACK (`OrtSession.SessionOptions.addXnnpack()`,
  confirmed present in `onnxruntime-android:1.27.0`'s Java API via
  `javap` against the real AAR from Maven Central), 2 threads
  (`intra_op_num_threads`), CPU EP as automatic fallback if XNNPACK init
  fails - same fallback pattern as every other gate-7 backend in this
  project. Deliberately **not** NNAPI (deprecated on Android 15) and
  **not** the NPU (its fixed per-call wake cost dominates for this
  cascade's tiny, sporadic inferences).
- **Input**: 320x320, NCHW float32, RGB, values in [0,1]. Letterboxed by
  padding to a square on the **bottom/right only** (black fill, no
  centering) then resizing - confirmed from `nudenet.py`'s own
  `_read_image`/`cv2.copyMakeBorder` + `cv2.dnn.blobFromImage` recipe in
  the PyPI package, not assumed.
- **Output**: `output0`, shape `[1, 22, 2100]` - confirmed by loading the
  actual ONNX graph and running it (`onnxruntime.InferenceSession.get_outputs()`
  plus a real inference call). 4 box channels (`cx, cy, w, h`, absolute
  320-space pixel coordinates, already grid+stride decoded in the graph) +
  18 class-confidence channels (already sigmoid-activated in-graph -
  confirmed by the output range on a random-noise input). **NMS is not
  baked into the graph** - `NudeNetDetector` runs its own greedy
  class-agnostic NMS (IoU 0.45, 0.2 candidate cutoff before NMS), matching
  `nudenet.py`'s own `cv2.dnn.NMSBoxes(boxes, scores, 0.25, 0.45)` call.

### Label-set gate, not a scalar threshold

`NudeNetGatePolicy.DEFAULT_BLOCK_THRESHOLDS` (in `NudeNetDetector.kt`) is
the only place block-list membership and per-label thresholds live -
config-driven the same way `SiglipNsfwClassifier`'s (now removed)
`DEFAULT_CLASS_POLICIES` was, a constructor-overridable map rather than
scattered `if (label == ...)` checks. Only four labels gate blocking by
default, each at 0.5: `FEMALE_GENITALIA_EXPOSED`, `MALE_GENITALIA_EXPOSED`,
`BUTTOCKS_EXPOSED`, `ANUS_EXPOSED`. Every other label - all `*_COVERED`
labels, `BELLY_EXPOSED`, `ARMPITS_EXPOSED`, `FEET_EXPOSED`, `FACE_MALE`,
`FACE_FEMALE` - is absent from the map, which means it never blocks
regardless of confidence.

**`FEMALE_BREAST_EXPOSED`/`MALE_BREAST_EXPOSED` are excluded from
`DEFAULT_BLOCK_THRESHOLDS` itself** (NudeNet has a documented tendency to
mislabel male chests as `FEMALE_BREAST_EXPOSED`, which for a cascade that
also sees a lot of sport/gym content risked making shirtless men the
dominant false-positive source), **but `NsfwClassifierFactory` currently
opts back in to `FEMALE_BREAST_EXPOSED` specifically** -
`BLOCK_FEMALE_BREAST_EXPOSED = true` at the top of
`NsfwClassifierFactory.kt` merges
`NudeNetGatePolicy.FEMALE_BREAST_EXPOSED_THRESHOLD` into the thresholds
passed to `NudeNetDetector`'s constructor, live as of this commit. This
means real female breast exposure now blocks, at the accepted cost that
NudeNet's gender-misclassification bug can still occasionally flag a
shirtless man as `FEMALE_BREAST_EXPOSED` too - watch for that specific
false-positive pattern. `MALE_BREAST_EXPOSED` stays off
(`NsfwClassifierFactory.BLOCK_MALE_BREAST_EXPOSED = false`) - flip that
constant too if you also want to block on that label after testing. Both
breast labels are always detected and logged regardless of whether they
gate blocking.

`NudeNetDetector.scoreNsfw()` (the `NsfwClassifier` interface method the
existing cascade calls) returns 1f if any block-listed label's detection
score exceeds its threshold, else 0f - same "always trips the app's
capped-at-1.0 `nsfwThreshold` slider" trick `SiglipNsfwClassifier` used, so
the label-set decision is authoritative regardless of where that slider
sits, without needing to touch `ContentGuardService`'s existing
threshold-compare line or any persisted setting.

### Per-frame logging + timing instrumentation

Every call to `NudeNetDetector.detect()`/`scoreNsfw()` logs one line (tag
`NudeNetDetector`, also mirrored to `DebugLogBuffer` for the Settings
"Debug log" card): the source package, the analyzed region's pixel
dimensions, every post-NMS detection (label + score + box), the block
decision, which execution provider actually served the inference, and a
preprocess/inference/decision timing breakdown.
`ContentGuardService.processFrame()` separately logs the capture-phase
timing (`captureMs`) right before calling into the classifier, so the full
capture -> preprocess -> inference -> decision chain is visible together
in `adb logcat -s NudeNetDetector ContentGuardService` (or the Debug log
card), tagged by the same package on every line.

### Known limitation, deliberately not worked around yet

320x320 is roughly a 4x downscale from a 1272px-class screen, and YOLO's
stride-8 detection head needs ~16px at *model* resolution to fire on
something - back-projected to the real screen, that's about 64px. A
fullscreen photo or video is unaffected; a small feed thumbnail may go
undetected. Rather than guess at a fix before real usage data justifies
the extra cost, the per-frame logging above exists specifically so
miss-rate can be measured first. `NudeNetDetector.TILED_ESCALATION_ENABLED`
is a disabled-by-default stub flag for a future 2x2 tiled-inference
escalation pass (`maybeRunTiledEscalation()`) - it's an unwired hook, not
an implementation; don't flip it until tiled inference is actually built
there.

## 6. Self-commitment: requiring a second person's approval before a build ships

This app is deliberately hard to loosen from *inside* itself (no in-app
off-switch for incognito detection, no way to disable the accessibility
watchdog from Settings) - but none of that stops someone from just asking
Claude Code (or editing the Kotlin directly) to loosen a threshold and
push a new build. The gap is closed at the CI/release level instead:
nothing reaches the real `latest-debug` release, and nothing becomes
installable, without a second person's real approval.

**First attempt (superseded)**: `.github/CODEOWNERS` + classic branch
protection (Settings > Branches, "Require a pull request before merging"
+ "Require review from Code Owners"). This still exists in the repo, but
**branch protection enforcement on a private repo needs a paid GitHub
plan** - it showed as configured but not actually enforced on the free
tier. `.github/CODEOWNERS` is left in place (harmless, currently inert) in
case this repo ever goes to a paid plan or public, at which point it
starts enforcing automatically with no further changes needed.

**What's actually live**: `build.yml` is split into two jobs. `build`
always runs immediately on every push to `main` - compiles the APK, no
gate, so there's a fast pass/fail signal same as before. `publish`
(the job that actually creates/updates the `latest-debug` release) targets
a GitHub *environment* named `release` with a required reviewer - this is
a deployment protection rule, a different feature from branch protection,
and is not gated behind a paid plan the way branch protection is on
private repos. `publish` rebuilds from scratch rather than receiving
`build`'s output via `actions/upload-artifact` - an early version tried
that hand-off and it hit the same account-wide Actions artifact storage
quota failure this project had already worked around once for the
release download itself, so the workflow now avoids touching that quota
anywhere. The Gradle cache (already configured) makes the second build
cheap. The `publish` job pauses in the Actions run's own UI until the
named reviewer clicks approve; nothing about pushing to `main` itself
is blocked, but the push alone doesn't produce a usable build - only an
approved `publish` job does.

**One-time setup, via github.com** (no API/CLI covers this - repo
environments aren't exposed by the GitHub MCP tools this project's
sessions have access to):

1. **Settings > Environments > New environment**, name it exactly
   `release` (must match `environment: release` in `build.yml`).
2. Under **"Deployment protection rules"**, enable **"Required
   reviewers"** and add the trusted second person.
3. Save.

**What changes day to day**: a push to `main` still lands immediately (no
PR step, unlike the superseded approach above) and the `build` job runs
right away, but the workflow run sits at `publish` marked "Waiting" until
the reviewer opens that run in the Actions tab and approves it - GitHub
notifies them the same way it would for any requested review, subject to
their own notification settings actually being on. Only after that
approval does the APK actually land on the `latest-debug` release URL
people download from.

_Live test (2026-07-17): confirming the required-reviewer gate holds after re-save._

## ColorOS / OPPO Find X9 Pro notes

See [`docs/COLOROS.md`](docs/COLOROS.md) for battery-optimization exemption,
Super Power Saving mode, and rebind guidance specific to this device.
