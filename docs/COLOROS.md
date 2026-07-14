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
not in the service's memory). If you're driving rebinds externally (e.g.
via MacroDroid watching for the service being off and re-enabling it), the
same `adb shell settings put secure enabled_accessibility_services ...`
command from `SETUP.md` is what such automation should invoke - or
equivalently, toggle Settings > Accessibility > ContentGuard off/on.

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
