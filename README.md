# ContentGuard

On-device adult-content blocker for Android, driven by an `AccessibilityService`.
Everything - screen capture, image-node detection, skin-tone prefiltering, the
NSFW classifier - runs locally; nothing leaves the device. Built for personal
use on a single device (OPPO Find X9 Pro / ColorOS 16), battery-first: a
cascade of cheap filters (app whitelist -> event debounce -> node-tree
inspection -> skin-tone histogram) exists specifically so the ML model runs as
rarely as possible.

No model is bundled - `assets/nsfw.tflite` is absent by design, and the app
runs with a stub classifier (always scores 0) until you drop one in. See
`app/src/main/assets/PLACE_MODEL_HERE.txt`.

See [`SETUP.md`](SETUP.md) for build/install instructions (command-line only,
no Android Studio) and [`docs/COLOROS.md`](docs/COLOROS.md) for ColorOS-specific
persistence notes.

## Architecture

One accessibility service (`service/ContentGuardService.kt`) orchestrates an
8-stage gating cascade, cheapest first, each stage exiting early whenever it
can:

1. App scope / whitelist (`scope/AppScopePolicy.kt`) - no capture at all.
2. Event debounce (`service/EventDebouncer.kt`).
3. Node-tree image-presence scan (`detect/NodeInspector.kt`) - no pixels yet.
4. Text/URL signal hook - a plug-in point, not a shipped blocklist.
5. Throttled `takeScreenshot()` (`capture/ScreenCapturer.kt`).
6. Skin-tone histogram prefilter (`detect/SkinTonePrefilter.kt`).
7. Quantized NSFW CNN (`detect/NsfwClassifier.kt` / `TFLiteNsfwClassifier.kt`).
8. Block via a reused `TYPE_ACCESSIBILITY_OVERLAY` view (`overlay/BlurOverlayController.kt`).

Settings UI (whitelist editor, scope mode, threshold) is Jetpack Compose /
Material 3, in `ui/SettingsActivity.kt`.
