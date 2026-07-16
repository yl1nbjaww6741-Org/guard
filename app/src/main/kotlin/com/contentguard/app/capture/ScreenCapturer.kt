package com.contentguard.app.capture

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.graphics.Bitmap
import android.graphics.Rect
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
     *
     * [cropRegion], if given (in real screen pixel coordinates, same space
     * as AccessibilityNodeInfo bounds), is applied to the *native-resolution*
     * screenshot before downscaling - cropping after the whole-frame
     * downscale instead (an earlier version of this cascade did that) means
     * a small region has already been squeezed through a low-res
     * intermediate step, throwing away exactly the detail a small feed
     * thumbnail needs for the classifier to read it confidently. Cropping
     * first means a small region can stay at or near its native resolution
     * since it's very unlikely to itself exceed [longestEdgePx].
     */
    suspend fun captureDownscaled(longestEdgePx: Int = TARGET_LONGEST_EDGE, cropRegion: Rect? = null): Bitmap? {
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
            val cropped = if (cropRegion != null) cropSafely(softwareBitmap, cropRegion) else softwareBitmap
            return downscale(cropped, longestEdgePx)
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

    private fun cropSafely(bitmap: Bitmap, region: Rect): Bitmap {
        val left = region.left.coerceIn(0, bitmap.width - 1)
        val top = region.top.coerceIn(0, bitmap.height - 1)
        val right = region.right.coerceIn(left + 1, bitmap.width)
        val bottom = region.bottom.coerceIn(top + 1, bitmap.height)
        return try {
            val cropped = Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
            if (cropped !== bitmap) bitmap.recycle()
            cropped
        } catch (e: Exception) {
            Log.w(TAG, "crop failed, using full frame", e)
            bitmap
        }
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

        // History: 900ms (near platform floor) -> 1500ms (battery) -> 900ms
        // (explicit "fast as possible" request) -> 1800ms. Doubled back up
        // once the pixel-based skin-region crop made per-frame detection
        // reliable enough that a slower cadence only costs latency (worst
        // case ~2s before a genuinely explicit frame gets caught), not
        // whether it gets caught at all - a better trade now than it would
        // have been before that fix.
        private const val THROTTLE_FLOOR_MS = 1800L

        const val TARGET_LONGEST_EDGE = 640
    }
}
