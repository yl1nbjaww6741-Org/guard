package com.contentguard.app.service

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.graphics.Rect
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.core.content.ContextCompat
import com.contentguard.app.capture.ScreenCapturer
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

    private data class FrameRequest(val packageName: String)

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs = PrefsRepository(applicationContext)
        scopePolicy = AppScopePolicy(prefs)
        debouncer = EventDebouncer()
        screenCapturer = ScreenCapturer(this, ContextCompat.getMainExecutor(this))
        nsfwClassifier = NsfwClassifierFactory.create(applicationContext)
        overlay = BlurOverlayController(
            service = this,
            onBackKeyPressed = {
                if (prefs.dismissOnBlock) {
                    performGlobalAction(GLOBAL_ACTION_BACK)
                    performGlobalAction(GLOBAL_ACTION_HOME)
                }
            },
            onOkTapped = {
                performGlobalAction(GLOBAL_ACTION_BACK)
                performGlobalAction(GLOBAL_ACTION_HOME)
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
     * static content still gets caught. CONFLATED channel + ScreenCapturer's
     * own throttle mean redundant ticks are cheap - they just exit at
     * GATE5_CAPTURE_THROTTLED_OR_FAILED when a real event already
     * triggered a capture recently.
     */
    private suspend fun recheckStaticContent() {
        while (serviceScope.isActive) {
            delay(STATIC_RECHECK_INTERVAL_MS)
            val pkg = lastForegroundPackage ?: continue
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

        if (!scan.hasImages) {
            exitSafe(pkg, "GATE3_NO_IMAGE_NODES")
            return
        }

        // Gate 4 (text/URL signal) is a hook, not a shipped blocklist - out
        // of scope per the design doc (no bundled lists, no cloud calls).
        // scan.visibleText is exactly where a known-good/known-bad keyword
        // or URL check would plug in, before we ever call takeScreenshot().

        val bitmap = screenCapturer.captureDownscaled()
        if (bitmap == null) {
            val line = "[$pkg] exit@GATE5_CAPTURE_THROTTLED_OR_FAILED"
            Log.d(TAG, line)
            DebugLogBuffer.add(TAG, line)
            return
        }
        prefs.recordScreenshot()

        val analysisBitmap = cropToImageRegion(bitmap, scan.imageBounds)
        try {
            if (!SkinTonePrefilter.looksSkinLike(analysisBitmap)) {
                exitSafe(pkg, "GATE6_NO_SKIN_TONE")
                return
            }

            val inferenceStartNanos = System.nanoTime()
            val score = nsfwClassifier.scoreNsfw(analysisBitmap)
            prefs.recordInference((System.nanoTime() - inferenceStartNanos) / 1_000_000)

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
            }
            withContext(Dispatchers.Main) { overlay.show(pkg) }
        } finally {
            if (analysisBitmap !== bitmap) analysisBitmap.recycle()
            bitmap.recycle()
        }
    }

    /**
     * Gate 6/7 both used to analyze the whole downscaled screenshot, which
     * dilutes a small feed thumbnail's skin-tone ratio against a mostly
     * text/background frame (a Reddit feed card is a small fraction of the
     * screen) - real explicit thumbnails were falling under gate 6's
     * threshold and only passing once the user opened the photo full-screen,
     * where it fills most of the frame. Crops to the union of detected image
     * regions instead, so a thumbnail is judged on its own content. Falls
     * back to the full frame if there's nothing to crop to or the bounds
     * turn out degenerate.
     */
    private fun cropToImageRegion(bitmap: Bitmap, imageBounds: List<Rect>): Bitmap {
        if (imageBounds.isEmpty()) return bitmap

        val union = Rect(imageBounds[0])
        for (i in 1 until imageBounds.size) union.union(imageBounds[i])

        val displayMetrics = resources.displayMetrics
        val scaleX = bitmap.width.toFloat() / displayMetrics.widthPixels
        val scaleY = bitmap.height.toFloat() / displayMetrics.heightPixels

        val left = (union.left * scaleX).toInt().coerceIn(0, bitmap.width - 1)
        val top = (union.top * scaleY).toInt().coerceIn(0, bitmap.height - 1)
        val right = (union.right * scaleX).toInt().coerceIn(left + 1, bitmap.width)
        val bottom = (union.bottom * scaleY).toInt().coerceIn(top + 1, bitmap.height)

        return try {
            Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
        } catch (e: Exception) {
            Log.w(TAG, "cropToImageRegion failed, using full frame", e)
            bitmap
        }
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
        // the comment at the call site.
        private val GUARDED_SETTINGS_TITLE_MARKERS = listOf("device admin", "accessibility")

        // Just above ScreenCapturer's own 1500ms throttle floor, so this
        // rarely fires more often than a real capture could happen anyway.
        private const val STATIC_RECHECK_INTERVAL_MS = 2000L
    }
}
