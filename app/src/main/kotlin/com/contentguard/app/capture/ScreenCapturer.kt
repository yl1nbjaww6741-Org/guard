package com.contentguard.app.capture

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.Executor
import kotlin.math.max

/** Gate 5 of the cascade: the only stage that touches real pixels. */
@RequiresApi(30)
class ScreenCapturer(
    private val service: AccessibilityService,
    private val callbackExecutor: Executor,
) {

    private var lastCaptureAt = 0L

    /**
     * Returns a downscaled software ARGB_8888 bitmap, or null if the frame
     * was skipped - either our own throttle floor hasn't elapsed (drop,
     * don't queue: gate 5 exists to protect the battery, not to guarantee
     * every frame gets scored) or the platform call itself failed/was
     * throttled.
     */
    suspend fun captureDownscaled(longestEdgePx: Int = TARGET_LONGEST_EDGE): Bitmap? {
        val now = SystemClock.elapsedRealtime()
        if (now - lastCaptureAt < THROTTLE_FLOOR_MS) {
            return null
        }

        val result = takeScreenshotSuspending() ?: return null
        lastCaptureAt = SystemClock.elapsedRealtime()

        val hardwareBuffer = result.hardwareBuffer
        try {
            val hardwareBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, result.colorSpace) ?: return null
            val softwareBitmap = try {
                hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false)
            } finally {
                hardwareBitmap.recycle()
            }
            return downscale(softwareBitmap, longestEdgePx)
        } finally {
            hardwareBuffer.close()
        }
    }

    private suspend fun takeScreenshotSuspending(): ScreenshotResult? =
        suspendCancellableCoroutine { cont ->
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                callbackExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(result: ScreenshotResult) {
                        if (cont.isActive) cont.resume(result, onCancellation = null)
                    }

                    override fun onFailure(errorCode: Int) {
                        // Common and expected under our own throttling, and
                        // also whenever ColorOS itself rate-limits or
                        // denies the call - see accessibility_service_config.xml.
                        Log.d(TAG, "takeScreenshot failed: errorCode=$errorCode")
                        if (cont.isActive) cont.resume(null, onCancellation = null)
                    }
                },
            )
        }

    private fun downscale(bitmap: Bitmap, longestEdgePx: Int): Bitmap {
        val longest = max(bitmap.width, bitmap.height)
        if (longest <= longestEdgePx) return bitmap

        val scale = longestEdgePx.toFloat() / longest
        val newWidth = max(1, (bitmap.width * scale).toInt())
        val newHeight = max(1, (bitmap.height * scale).toInt())
        val scaled = Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
        if (scaled !== bitmap) bitmap.recycle()
        return scaled
    }

    companion object {
        private const val TAG = "ScreenCapturer"

        // AccessibilityService.takeScreenshot() is itself rate-limited by
        // the platform (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT below
        // roughly one call/second) - 900ms would sit just under that floor
        // for maximum responsiveness. Deliberately raised to 1500ms instead:
        // real on-device logs showed captures landing ~1.0-1.1s apart during
        // active scrolling anyway (throttle + real processing overhead), so
        // 900ms bought little responsiveness in practice while costing a
        // capture+inference on every single one. 1500ms cuts capture
        // frequency by roughly 40% for a real battery win, at the cost of
        // being more likely to skip content that flashes by very quickly
        // during fast scrolling rather than pausing on it.
        private const val THROTTLE_FLOOR_MS = 1500L

        const val TARGET_LONGEST_EDGE = 640
    }
}
