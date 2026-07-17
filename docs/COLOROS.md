# ColorOS 16 (OPPO Find X9 Pro) persistence notes

ColorOS layers its own aggressive battery/process management on top of
AOSP, on top of which the standard Android accessibility-binding and
`takeScreenshot()` APIs sit. Two ColorOS-specific things can silently break
ContentGuard that don't exist on stock Android:

## 1. Battery optimization / background-kill

ColorOS's own battery manager (distinct from AOSP's Doze/App Standby,
which `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` only affects) can kill or
freeze background services regardless of the standard "ignore battery
optimizations" exemption. To reduce the chance of ContentGuard's
accessibility binding getting dropped:

1. Settings > Battery > ContentGuard > allow "Background running" /
   disable ColorOS's own battery restriction for the app (exact wording
   varies by ColorOS build).
2. Settings > Apps > App management > ContentGuard > Battery usage > set
   to "Allow" / "No restrictions".
3. Tap **"Ignore Battery Optimizations"** in ContentGuard's own settings
   screen too - this covers the AOSP-level exemption, which is necessary
   but not sufficient on ColorOS.
4. Some ColorOS versions have a separate "Startup manager" / "Auto-start"
   list - make sure ContentGuard is allowed to auto-start, or the
   accessibility service may not be re-bound after a reboot.

## 2. Super Power Saving Mode

ColorOS's Super Power Saving mode is known to suspend accessibility
service bindings even for apps otherwise exempted from battery
optimization - the whole point of that mode is to freeze almost everything
except a tiny allowlist (calls/SMS/a couple of chosen apps), and
accessibility services are not guaranteed to survive it.

**Do not assume the service is always alive.** The app is built around
this: rebinding is just re-toggling accessibility, which is cheap and
stateless (all persisted state lives in `PrefsRepository`/SharedPreferences,
not in the service's memory). This used to require external automation
(e.g. MacroDroid watching for the service being off and re-enabling it) -
see section 4 below for why that's now built directly into the app
instead via `AccessibilityWatchdogService`.

## 4. "Hide apps" also strips the accessibility permission

Confirmed via direct testing: using ColorOS's own "Hide apps" feature on
ContentGuard doesn't just remove the launcher icon - it also silently
removes ContentGuardService from
`Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`, turning off every gate
in the cascade with no warning. MacroDroid was confirmed to survive the
exact same action on the same device - it very likely does so by watching
for exactly this and writing itself back into the enabled-services list
(MacroDroid documents needing `WRITE_SECURE_SETTINGS` for this kind of
self-management, corroborating evidence this is the right mechanism, not
just a guess).

`AccessibilityWatchdogService` (see its own doc comment in
`app/src/main/kotlin/com/contentguard/app/service/`) implements the same
thing directly in ContentGuard: a `ContentObserver` on
`ENABLED_ACCESSIBILITY_SERVICES` reacts immediately when the OS strips the
service out, and restores it via `WRITE_SECURE_SETTINGS` (same one-time
adb grant as documented in `SETUP.md`'s enable instructions -
`adb shell pm grant <applicationId> android.permission.WRITE_SECURE_SETTINGS`).
It runs as its own foreground service, deliberately separate from
ContentGuardService, since the whole point is recovering from
ContentGuardService itself being torn down - watchdog logic living inside
that same service would die at the exact moment it's needed.

**Known limitation, not fixable from the app's own code**: if "Hide apps"
ever kills this watchdog service's own process outright (rather than just
deregistering the accessibility service while everything else keeps
running), it can't self-heal - there's no code that can run once its own
process is gone. Real-device testing is the only way to confirm which
case this device falls into; MacroDroid persisting is decent evidence it's
the recoverable case, but that isn't a guarantee ContentGuard's own
process is treated identically.

## 3. `takeScreenshot()` capability flag

`android:canTakeScreenshot="true"` in `accessibility_service_config.xml` is
what grants `CAPABILITY_CAN_TAKE_SCREENSHOT` for
`AccessibilityService.takeScreenshot()` (API 30+). This is exactly the kind
of flag OEM skins sometimes gate behind their own extra toggle. **Verify
on-device**: if `takeScreenshot()`'s callback consistently reports a
failure code (watch for it via `adb logcat -s ScreenCapturer`), check
Settings > Accessibility > ContentGuard for any ColorOS-specific
permission/toggle around screenshots or screen recording before assuming
the API itself is broken - the AOSP flag alone is what the framework
requires, but OEM skins have been known to add their own gate on top of
capabilities like this one.
