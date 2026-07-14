package com.contentguard.app.service

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.core.content.ContextCompat
import com.contentguard.app.capture.ScreenCapturer
import com.contentguard.app.detect.NodeInspector
import com.contentguard.app.detect.NsfwClassifier
import com.contentguard.app.detect.NsfwClassifierFactory
import com.contentguard.app.detect.SkinTonePrefilter
import com.contentguard.app.overlay.BlurOverlayController
import com.contentguard.app.scope.AppScopePolicy
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.util.DebugLogBuffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
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

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val frameChannel = Channel<FrameRequest>(Channel.CONFLATED)

    private var lastForegroundPackage: String? = null

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
            onBackKeyPressed = { if (prefs.dismissOnBlock) performGlobalAction(GLOBAL_ACTION_BACK) },
            onOkTapped = { performGlobalAction(GLOBAL_ACTION_BACK) },
        )

        serviceScope.launch { consumeFrames() }
        Log.i(TAG, "connected: mode=${prefs.mode} threshold=${prefs.nsfwThreshold}")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val packageName = event.packageName?.toString() ?: return

        val isRealAppSwitch = event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            packageName != lastForegroundPackage &&
            !scopePolicy.isHardExcluded(packageName)

        if (isRealAppSwitch) {
            lastForegroundPackage = packageName
            if (overlay.isVisible()) {
                serviceScope.launch(Dispatchers.Main) { overlay.hide() }
            }
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

        try {
            if (!SkinTonePrefilter.looksSkinLike(bitmap)) {
                exitSafe(pkg, "GATE6_NO_SKIN_TONE")
                return
            }

            val inferenceStartNanos = System.nanoTime()
            val score = nsfwClassifier.scoreNsfw(bitmap)
            prefs.recordInference((System.nanoTime() - inferenceStartNanos) / 1_000_000)

            if (score < prefs.nsfwThreshold) {
                exitSafe(pkg, "GATE7_BELOW_THRESHOLD score=$score")
                return
            }

            val blockLine = "[$pkg] exit@GATE8_BLOCK score=$score"
            Log.i(TAG, blockLine)
            DebugLogBuffer.add(TAG, blockLine)
            prefs.recordBlock()
            withContext(Dispatchers.Main) { overlay.show(pkg) }
        } finally {
            bitmap.recycle()
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
        if (::nsfwClassifier.isInitialized) nsfwClassifier.close()
        serviceScope.cancel()
    }

    companion object {
        private const val TAG = "ContentGuardService"
    }
}
