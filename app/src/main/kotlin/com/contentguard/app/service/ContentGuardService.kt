package com.contentguard.app.service

import android.accessibilityservice.AccessibilityService
import android.app.ActivityManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.PowerManager
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.content.ContextCompat
import com.contentguard.app.capture.ScreenCapturer
import com.contentguard.app.detect.IncognitoDetector
import com.contentguard.app.detect.KeywordBlocklist
import com.contentguard.app.detect.NodeInspector
import com.contentguard.app.detect.NsfwClassifier
import com.contentguard.app.detect.NsfwClassifierFactory
import com.contentguard.app.detect.SkinTonePrefilter
import com.contentguard.app.overlay.BlurOverlayController
import com.contentguard.app.overlay.PasswordGuardOverlayController
import com.contentguard.app.scope.AppScopePolicy
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.util.DebugLogBuffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Orchestrates the whole gating cascade. Every stage funnels through a
 * single consumer coroutine fed by a CONFLATED channel: a new frame
 * request overwrites whatever the consumer hasn't gotten to yet, so under
 * event bursts (fast scrolling, rapid app switches) we only ever process
 * the latest screen state, never a backlog. There is exactly one
 * in-flight cascade run at a time.
 */
class ContentGuardService : AccessibilityService() {

    private lateinit var prefs: PrefsRepository
    private lateinit var scopePolicy: AppScopePolicy
    private lateinit var debouncer: EventDebouncer
    private lateinit var screenCapturer: ScreenCapturer
    private lateinit var nsfwClassifier: NsfwClassifier
    private lateinit var overlay: BlurOverlayController
    private lateinit var passwordGuardOverlay: PasswordGuardOverlayController

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val frameChannel = Channel<FrameRequest>(Channel.CONFLATED)

    private var lastForegroundPackage: String? = null
    private var settingsGuardUnlocked = false
    private var onGuardedSettingsScreen = false

    private val activityManager: ActivityManager by lazy { getSystemService(ActivityManager::class.java) }
    private val powerManager: PowerManager by lazy { getSystemService(PowerManager::class.java) }

    private data class FrameRequest(val packageName: String)

    override fun onServiceConnected() {
        super.onServiceConnected()
        // Defensive start - BootReceiver is the main entry point after a
        // reboot, but this covers the case where the watchdog isn't
        // already running yet (e.g. right after this feature first ships,
        // with no reboot in between). See AccessibilityWatchdogService's
        // doc comment for why it has to be a separate service.
        AccessibilityWatchdogService.start(applicationContext)
        prefs = PrefsRepository(applicationContext)
        scopePolicy = AppScopePolicy(prefs)
        debouncer = EventDebouncer()
        screenCapturer = ScreenCapturer(this, ContextCompat.getMainExecutor(this), prefs)
        nsfwClassifier = NsfwClassifierFactory.create(applicationContext)
        overlay = BlurOverlayController(
            service = this,
            onBackKeyPressed = {
                if (prefs.dismissOnBlock) {
                    serviceScope.launch(Dispatchers.Main) { dismissBlockedApp() }
                }
            },
            onOkTapped = {
                serviceScope.launch(Dispatchers.Main) { dismissBlockedApp() }
            },
        )
        passwordGuardOverlay = PasswordGuardOverlayController(
            service = this,
            onVerify = { entered -> prefs.verifyPassword(entered) },
            onUnlocked = { settingsGuardUnlocked = true },
            onCancelled = { performGlobalAction(GLOBAL_ACTION_HOME) },
        )

        serviceScope.launch { consumeFrames() }
        serviceScope.launch { recheckStaticContent() }
        Log.i(TAG, "connected: mode=${prefs.mode} threshold=${prefs.nsfwThreshold}")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val packageName = event.packageName?.toString() ?: return

        // The on-screen keyboard opening/closing fires its own
        // TYPE_WINDOW_STATE_CHANGED with its own package - not a real app
        // switch. Without this check, that event set lastForegroundPackage
        // to the IME's package, and the periodic static-content recheck
        // then spent seconds re-querying the keyboard instead of whatever
        // app (and image) was actually still on screen underneath it. Real
        // app activities report as TYPE_APPLICATION; IME/system/overlay
        // windows don't.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && !isApplicationWindow(event.windowId)) {
            return
        }

        // Temporary: the "contentguard" title marker (added to guard
        // ColorOS's per-app battery page) didn't take effect on real-device
        // retesting - this logs every real window-state-change's package
        // and title so we can see directly whether that screen (1) isn't
        // actually hosted in SETTINGS_PACKAGE, (2) never fires
        // TYPE_WINDOW_STATE_CHANGED at all (e.g. an in-place fragment swap
        // within the same window), or (3) reports different title text
        // than expected - rather than guessing a third time. Remove once
        // diagnosed.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val debugLine = "[$packageName] GATE_SETTINGS_GUARD_DEBUG title=\"${event.text.joinToString(" ")}\""
            Log.i(TAG, debugLine)
            DebugLogBuffer.add(TAG, debugLine)
        }

        val isRealAppSwitch = event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            packageName != lastForegroundPackage &&
            !scopePolicy.isHardExcluded(packageName)

        if (isRealAppSwitch) {
            lastForegroundPackage = packageName
            if (packageName != SETTINGS_PACKAGE) {
                settingsGuardUnlocked = false
                onGuardedSettingsScreen = false
            }
            if (overlay.isVisible() && !prefs.isLockedOut(packageName)) {
                serviceScope.launch(Dispatchers.Main) { overlay.hide() }
            }
        }

        // Keyed on the window's own title (from the TYPE_WINDOW_STATE_CHANGED
        // event), not a scan of all visible text - scanning all text was
        // matching "Device admin apps" and "Accessibility" wherever those
        // words appeared, including as search-suggestion chips on Settings'
        // own search screen, which isn't the real screen at all.
        if (packageName == SETTINGS_PACKAGE && event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val screenTitle = event.text.joinToString(" ").lowercase()
            onGuardedSettingsScreen = GUARDED_SETTINGS_TITLE_MARKERS.any { screenTitle.contains(it) }
        }

        if (packageName == SETTINGS_PACKAGE && onGuardedSettingsScreen && prefs.hasPassword() && !settingsGuardUnlocked) {
            if (!passwordGuardOverlay.isVisible()) {
                val line = "[$packageName] exit@GATE_SETTINGS_GUARD"
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                serviceScope.launch(Dispatchers.Main) { passwordGuardOverlay.show() }
            }
            return
        }

        if (prefs.isLockedOut(packageName)) {
            // Gate on overlay visibility, not isRealAppSwitch: the 3rd
            // strike usually fires while the user is already inside the
            // offending app (no app-switch event ever occurs), so keying
            // off isRealAppSwitch alone left the lockout invisible unless
            // the user happened to leave and come back. Any event in a
            // locked-out package re-shows the block whenever it isn't
            // already up - including right after the user dismisses it
            // and stays put, which is exactly when it must persist.
            if (!overlay.isVisible()) {
                val line = "[$packageName] exit@GATE0_LOCKED_OUT"
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                serviceScope.launch(Dispatchers.Main) { overlay.show(packageName) }
            }
            return
        }

        if (!scopePolicy.shouldMonitor(packageName)) {
            Log.d(TAG, "[$packageName] exit@GATE1_WHITELIST")
            return
        }

        // Restricted to known browser packages so this can never trigger
        // on an unrelated app (Gboard's own "Incognito mode" privacy
        // indicator was matching here before that restriction was added -
        // see IncognitoDetector's doc comment). Confirmed correct against
        // real on-device titles: a regular tab reports e.g. "Chrome: New
        // tab" (no match) while an incognito tab reports "Chrome: New
        // Incognito tab" (matches) - the window's own title, a single
        // short string, isn't at risk of the whole-tree concatenation
        // false positives that affected the content-based check earlier.
        if (IncognitoDetector.isBrowserPackage(packageName) &&
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) {
            val windowTitle = event.text.joinToString(" ")
            if (IncognitoDetector.matchesTitle(windowTitle)) {
                if (!overlay.isVisible()) {
                    val line = "[$packageName] exit@GATE4_INCOGNITO_DETECTED title=\"$windowTitle\""
                    Log.i(TAG, line)
                    DebugLogBuffer.add(TAG, line)
                    serviceScope.launch(Dispatchers.Main) { overlay.show(packageName) }
                }
                return
            }
        }

        if (!debouncer.shouldProcess(event)) {
            Log.d(TAG, "[$packageName] exit@GATE2_DEBOUNCE")
            return
        }

        // CONFLATED: overwrites any request the consumer hasn't picked up yet.
        frameChannel.trySend(FrameRequest(packageName))
    }

    private suspend fun consumeFrames() {
        for (request in frameChannel) {
            try {
                processFrame(request)
            } catch (e: Exception) {
                Log.e(TAG, "cascade error for ${request.packageName}", e)
            }
        }
    }

    /**
     * The cascade is otherwise purely event-driven - it only runs when an
     * AccessibilityEvent fires (scroll, content change, app switch). A user
     * static on an already-rendered image generates no further events at
     * all, so real content could sit on screen indefinitely without ever
     * being re-scanned. This periodically re-queues a frame for whatever
     * app is currently foreground, independent of events, so dwelling on
     * static content still gets caught. Interval is prefs.staticRecheckIntervalMs
     * (derived from the user-tunable capture cadence in Settings, see
     * PrefsRepository), not a fixed constant. CONFLATED channel + ScreenCapturer's
     * own throttle mean redundant ticks are cheap while the screen is
     * genuinely in use - they just exit at GATE5_CAPTURE_THROTTLED_OR_FAILED
     * when a real event already triggered a capture recently. Skips entirely
     * while the screen is off (see the isInteractive check below) - that's
     * the loop's main real battery cost, since it otherwise runs on this
     * timer 24/7 regardless of whether anything is actually on screen to
     * protect against.
     *
     * Deliberately queries rootInActiveWindow fresh on every tick instead
     * of reusing lastForegroundPackage - that field is only as reliable as
     * the event stream driving it, and real testing found brief,
     * legitimate-looking TYPE_APPLICATION window events for other packages
     * (the IME opening/closing; a partial gesture-nav swipe briefly
     * showing the launcher behind the current app) hijacking it for
     * seconds at a time, during which this recheck kept re-querying the
     * wrong app entirely while real content sat unscanned underneath.
     * Asking the OS what's actually active right now sidesteps that whole
     * class of bug rather than trying to enumerate every spurious source.
     *
     * Also applies the same isApplicationWindow check onAccessibilityEvent
     * already does, which this loop was missing entirely - rootInActiveWindow
     * isn't restricted to TYPE_APPLICATION, and real-device logs showed the
     * IME's own window (com.google.android.inputmethod.latin) repeatedly
     * becoming "the active window" from typing alone, with no app ever
     * opened, getting captured and scored every tick as a result.
     */
    private suspend fun recheckStaticContent() {
        while (serviceScope.isActive) {
            delay(prefs.staticRecheckIntervalMs)

            // Unlike onAccessibilityEvent (naturally quiet with the screen
            // off, since no window-state changes occur), this loop is timer-
            // driven and previously kept firing every tick regardless -
            // accessibility services aren't Doze-throttled the way ordinary
            // apps are, so this ran 24/7 including screen-off stretches
            // (pocket, overnight charging). isInteractive is false whenever
            // the display isn't actually on, at which point nothing could be
            // visible to detect - skipping here is a pure win, not a
            // detection trade-off the way the interval/threshold tuning
            // elsewhere in this file is. rootInActiveWindow can also still
            // report the last-foreground app after the screen turns off, so
            // this check has to happen before capture is even attempted, not
            // rely on ScreenCapturer's own throttle to make it cheap - that
            // throttle (1800ms) is shorter than this loop's own interval
            // (2000ms), so it wouldn't actually suppress a capture attempt
            // here the way it does for genuinely redundant same-second ticks.
            if (!powerManager.isInteractive) continue

            val root = rootInActiveWindow
            val pkg = root?.packageName?.toString()
            val windowId = root?.windowId
            @Suppress("DEPRECATION")
            root?.recycle()
            if (pkg == null) continue
            // Same defense onAccessibilityEvent already applies to the
            // event-driven path (see the IME-hijacking comment above) - it
            // was missing here. rootInActiveWindow isn't limited to
            // TYPE_APPLICATION windows, and an IME window (Gboard etc.) can
            // genuinely become "the active window" while it has input
            // focus, not just via a spurious event - real-device logs
            // showed this loop repeatedly queuing and scoring
            // com.google.android.inputmethod.latin every ~2s purely from
            // typing, with no app ever opened. A keyboard's own window is
            // never content worth scoring regardless of scope mode.
            if (windowId != null && !isApplicationWindow(windowId)) continue
            if (onGuardedSettingsScreen || prefs.isLockedOut(pkg) || !scopePolicy.shouldMonitor(pkg)) continue
            frameChannel.trySend(FrameRequest(pkg))
        }
    }

    private suspend fun processFrame(request: FrameRequest) {
        val pkg = request.packageName

        val root = rootInActiveWindow
        if (root == null) {
            exitSafe(pkg, "GATE_NO_ROOT")
            return
        }
        val scan = try {
            NodeInspector.scan(root)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }

        // Fallback for when the window-title check in onAccessibilityEvent
        // didn't catch it (e.g. the title only changes on the initial
        // window-state-change and a private tab's *content* wasn't loaded
        // yet at that point). Restricted to known browser packages and to
        // the narrower CONTENT_KEYWORDS set - see IncognitoDetector's doc
        // comment for why the whole-tree scan can't safely use the same
        // bare "incognito" keyword the title check does. Checked before
        // GATE3's image-content check, deliberately - this blocks private
        // browsing outright regardless of whether there's an image on
        // screen at all, since capture (gates 5-7) structurally cannot see
        // into a FLAG_SECURE window anyway.
        val matchedContentKeyword = if (IncognitoDetector.isBrowserPackage(pkg)) {
            IncognitoDetector.matchingContentKeyword(scan.visibleText)
        } else {
            null
        }
        if (matchedContentKeyword != null) {
            // Logs which keyword matched, not just that gate 4 fired - if this
            // is ever a false positive on an ordinary (non-incognito) tab, the
            // log immediately says what tripped it instead of leaving another
            // unexplained "Chrome fully blocked" report to re-investigate from
            // scratch (see IncognitoDetector's doc comment).
            if (!overlay.isVisible()) {
                val line = "[$pkg] exit@GATE4_INCOGNITO_DETECTED content keyword=\"$matchedContentKeyword\""
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                withContext(Dispatchers.Main) { overlay.show(pkg) }
            }
            return
        }

        // Blocks on explicit search intent - what's typed into an address
        // bar or search box - before any page/image ever loads. Matches
        // against scan.inputFieldText specifically (editable nodes only),
        // not the whole-page visibleText above, so this doesn't inherit
        // gate 4's false-positive history from matching ordinary page
        // content. See KeywordBlocklist's doc comment. Checked before
        // GATE3 for the same reason as the incognito checks above - this
        // blocks outright regardless of whether an image is on screen.
        val matchedExplicitKeyword = if (IncognitoDetector.isBrowserPackage(pkg)) {
            KeywordBlocklist.matchingKeyword(scan.inputFieldText, prefs.getExplicitKeywords())
        } else {
            null
        }
        if (matchedExplicitKeyword != null) {
            if (!overlay.isVisible()) {
                val line = "[$pkg] exit@GATE4B_KEYWORD_BLOCKED keyword=\"$matchedExplicitKeyword\""
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                withContext(Dispatchers.Main) { overlay.show(pkg) }
            }
            return
        }

        if (!scan.hasImages) {
            exitSafe(pkg, "GATE3_NO_IMAGE_NODES")
            return
        }

        // Crop to the union of detected image regions at capture time, not
        // after the whole-frame downscale - cropping post-downscale (an
        // earlier version of this cascade did that) means a small feed
        // thumbnail has already been squeezed through a low-res
        // intermediate step before the crop even happens, throwing away
        // exactly the detail the classifier needs to read it confidently.
        // Cropping the native-resolution screenshot first lets a small
        // region stay near its real resolution instead.
        val cropRegion = unionOf(scan.imageBounds)

        val captureStartNanos = System.nanoTime()
        val bitmap = screenCapturer.captureDownscaled(cropRegion = cropRegion)
        val captureMs = (System.nanoTime() - captureStartNanos) / 1_000_000
        if (bitmap == null) {
            val line = "[$pkg] exit@GATE5_CAPTURE_THROTTLED_OR_FAILED"
            Log.d(TAG, line)
            DebugLogBuffer.add(TAG, line)
            return
        }
        prefs.recordScreenshot()

        val skinAnalysis = SkinTonePrefilter.analyze(bitmap)
        if (!skinAnalysis.hasSkin) {
            exitSafe(pkg, "GATE6_NO_SKIN_TONE")
            bitmap.recycle()
            return
        }

        // Refine to wherever skin is actually concentrated, on top of
        // whatever crop (if any) the accessibility tree already gave us -
        // real testing found a photo's surrounding UI chrome (header,
        // username/title, vote/comment buttons, even the next post
        // already peeking in) diluting classifier confidence the same way
        // regardless of app/framework, since the accessibility-based crop
        // can't reliably isolate the photo alone in every case. This
        // works directly off pixels, so it doesn't depend on any
        // particular app exposing precise bounds.
        val analysisBitmap = skinAnalysis.region?.let { cropToRegion(bitmap, it) } ?: bitmap

        try {
            val inferenceStartNanos = System.nanoTime()
            val score = nsfwClassifier.scoreNsfw(analysisBitmap, pkg)
            prefs.recordInference((System.nanoTime() - inferenceStartNanos) / 1_000_000)
            DebugLogBuffer.add(TAG, "[$pkg] captureMs=$captureMs")

            if (score < prefs.nsfwThreshold) {
                exitSafe(pkg, "GATE7_BELOW_THRESHOLD score=$score")
                return
            }

            val blockLine = "[$pkg] exit@GATE8_BLOCK score=$score"
            Log.i(TAG, blockLine)
            DebugLogBuffer.add(TAG, blockLine)
            prefs.recordBlock()
            if (prefs.recordExplicitStrike(pkg)) {
                val lockLine = "[$pkg] LOCKOUT_TRIGGERED durationMin=${prefs.lockoutDurationMinutes}"
                Log.i(TAG, lockLine)
                DebugLogBuffer.add(TAG, lockLine)

                // Stronger than the plain GLOBAL_ACTION_HOME every block
                // already does on dismissal - on the strike that actually
                // trips the lockout, back out of the app immediately
                // (rather than waiting for the user to tap through the
                // fake-crash dialog first) and ask the OS to kill its
                // background process, so switching back via Recents finds
                // a cold start instead of resuming exactly where they left
                // off. killBackgroundProcesses() only needs the normal
                // KILL_BACKGROUND_PROCESSES permission (no root/adb), but
                // it's a hint the OS can decline, not a guaranteed kill
                // the way Settings' own "Force Stop" button is - that API
                // is signature-protected and unavailable to third-party
                // apps even with Shizuku's shell-level access.
                withContext(Dispatchers.Main) { performGlobalAction(GLOBAL_ACTION_HOME) }
                delay(500)
                activityManager.killBackgroundProcesses(pkg)
                val killLine = "[$pkg] KILL_BACKGROUND_PROCESSES requested after lockout"
                Log.i(TAG, killLine)
                DebugLogBuffer.add(TAG, killLine)
            }
            withContext(Dispatchers.Main) { overlay.show(pkg) }
        } finally {
            if (analysisBitmap !== bitmap) analysisBitmap.recycle()
            bitmap.recycle()
        }
    }

    private fun cropToRegion(bitmap: Bitmap, region: Rect): Bitmap {
        val left = region.left.coerceIn(0, bitmap.width - 1)
        val top = region.top.coerceIn(0, bitmap.height - 1)
        val right = region.right.coerceIn(left + 1, bitmap.width)
        val bottom = region.bottom.coerceIn(top + 1, bitmap.height)
        return try {
            Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
        } catch (e: Exception) {
            Log.w(TAG, "cropToRegion failed, using full frame", e)
            bitmap
        }
    }

    /**
     * Backs out of a dismissed block twice, not once, before landing on
     * the home screen. A single back-press often only closes an in-app
     * photo/video viewer without leaving the app itself - which meant
     * Recents' task-switcher thumbnail for that app could still show
     * whatever explicit content was last rendered right before the
     * overlay went up, even though the overlay itself was gone. The delay
     * between each action gives its UI transition a real chance to finish
     * before the next one fires, rather than racing/coalescing them.
     */
    private suspend fun dismissBlockedApp() {
        performGlobalAction(GLOBAL_ACTION_BACK)
        delay(200)
        performGlobalAction(GLOBAL_ACTION_BACK)
        delay(200)
        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    /** Fails open (true) if the window can't be found - matches prior behavior for that case. */
    private fun isApplicationWindow(windowId: Int): Boolean {
        val window = windows.firstOrNull { it.id == windowId } ?: return true
        return window.type == AccessibilityWindowInfo.TYPE_APPLICATION
    }

    private fun unionOf(rects: List<Rect>): Rect? {
        if (rects.isEmpty()) return null
        val union = Rect(rects[0])
        for (i in 1 until rects.size) union.union(rects[i])
        return union
    }

    /**
     * Logs a safe gate exit. Deliberately does NOT hide the overlay here:
     * once shown, a block should only go away via a genuine app switch
     * (handled in onAccessibilityEvent) or the user dismissing the fake
     * crash dialog themselves (BlurOverlayController's onOkTapped/
     * onBackKeyPressed) - not because the cascade re-evaluated whatever
     * the blocked app changed to in the background (autoplay advancing,
     * an ad rotating, infinite scroll loading fresh content) as "safe".
     * That was a real bug: the block could silently vanish with no user
     * action at all.
     */
    private fun exitSafe(pkg: String, gate: String) {
        val line = "[$pkg] exit@$gate"
        Log.d(TAG, line)
        DebugLogBuffer.add(TAG, line)
    }

    override fun onInterrupt() {
        Log.w(TAG, "onInterrupt")
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::overlay.isInitialized && overlay.isVisible()) overlay.hide()
        if (::passwordGuardOverlay.isInitialized && passwordGuardOverlay.isVisible()) passwordGuardOverlay.hide()
        if (::nsfwClassifier.isInitialized) nsfwClassifier.close()
        serviceScope.cancel()
    }

    companion object {
        private const val TAG = "ContentGuardService"

        // Standard AOSP Settings package - the "Device admin apps" and
        // "Accessibility" screens are core fragments OEMs rarely
        // reimplement (unlike the heavily-customized battery/app-info
        // screens elsewhere in ColorOS), so this should hold even though
        // other Settings screens don't.
        private const val SETTINGS_PACKAGE = "com.android.settings"

        // Matched against the window's own title, not screen content - see
        // the comment at the call site. "contentguard" added after
        // real-device testing found ColorOS's own battery-management page
        // for this app (Settings > Battery > ContentGuard, distinct from
        // the standard AOSP "App info" screen) has its own "Force stop"
        // button that Device Admin's force-stop protection doesn't reach -
        // that protection only greys out the button on the standard App
        // info page, not on every OEM screen that happens to offer the
        // same action. The app's own display label ("ContentGuard") is
        // this screen's window title, and doubles as a robust catch-all:
        // any Settings screen titled "ContentGuard" is inherently a
        // management surface for this app specifically (App info, this
        // battery page, permissions, whatever else ColorOS nests under
        // it), so guarding on the title rather than enumerating every
        // OEM-specific screen by its own wording covers this and similar
        // screens at once.
        private val GUARDED_SETTINGS_TITLE_MARKERS = listOf("device admin", "accessibility", "contentguard")
    }
}
