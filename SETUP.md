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

## ColorOS / OPPO Find X9 Pro notes

See [`docs/COLOROS.md`](docs/COLOROS.md) for battery-optimization exemption,
Super Power Saving mode, and rebind guidance specific to this device.
