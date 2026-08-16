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
import com.contentguard.app.scope.PrefsRepository
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executor
import kotlin.math.max

/** Gate 5 of the cascade: the only stage that touches real pixels. */
@RequiresApi(30)
class ScreenCapturer(
    private val service: AccessibilityService,
    private val callbackExecutor: Executor,
    private val prefs: PrefsRepository,
) {

    private var lastCaptureAt = 0L

    /**
     * Why this isn't just a nullable Bitmap: "we deliberately skipped this
     * frame to save battery" and "the platform refused to give us the
     * screen" are completely different events that a null return collapsed
     * into one. The first is the throttle working as designed and happens
     * constantly; the second means the cascade is blind and, on an OEM skin
     * that rate-limits or denies screenshots to accessibility services (see
     * accessibility_service_config.xml), can persist. They were logged under
     * a single GATE5_CAPTURE_THROTTLED_OR_FAILED line, so a log full of them
     * could not distinguish "healthy and throttling" from "capturing nothing
     * at all" without inferring it from the spacing of successful frames.
     */
    sealed interface CaptureResult {
        /** A real frame. The caller owns [bitmap] and must recycle it. */
        class Success(val bitmap: Bitmap) : CaptureResult

        /** Dropped at our own throttle floor. Expected, cheap, not a problem. */
        object Throttled : CaptureResult

        /**
         * The platform refused, or handed back a frame we couldn't use.
         * [errorCode] is AccessibilityService's own ERROR_TAKE_SCREENSHOT_*
         * constant, or null when the call succeeded but the buffer could not
         * be wrapped.
         */
        class Failed(val errorCode: Int?) : CaptureResult
    }

    /**
     * Returns a downscaled software ARGB_8888 bitmap, or the reason no frame
     * was produced - see [CaptureResult]. Gate 5 exists to protect the
     * battery, not to guarantee every frame gets scored, so a throttled frame
     * is dropped rather than queued.
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
    suspend fun captureDownscaled(longestEdgePx: Int = TARGET_LONGEST_EDGE, cropRegion: Rect? = null): CaptureResult {
        if (wouldThrottle()) {
            return CaptureResult.Throttled
        }

        val attempt = takeScreenshotSuspending()

        // Stamped for a FAILED attempt too, not just a successful one. The
        // throttle is a rate limit on how often we ask the platform for the
        // screen, and a refused request cost just as much to make as an
        // honoured one. Previously the stamp sat after the failure's early
        // return, so a failure left the clock unmoved, wouldThrottle() stayed
        // false, and the next admitted event retried immediately - turning a
        // run of refusals into takeScreenshot() calls at the debouncer's
        // 100ms event rate instead of once per captureThrottleMs, each one
        // preceded by a full accessibility-tree walk. Worse, the platform's
        // own limit (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) is itself
        // triggered by asking too fast, so the failure loop sustained itself.
        // Cost of stamping: one transient failure now waits a full interval
        // before retrying rather than retrying at once.
        lastCaptureAt = SystemClock.elapsedRealtime()

        val result = when (attempt) {
            is ScreenshotAttempt.Ok -> attempt.result
            is ScreenshotAttempt.Error -> return CaptureResult.Failed(attempt.errorCode)
        }

        val hardwareBuffer = result.hardwareBuffer
        try {
            val hardwareBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, result.colorSpace)
                ?: return CaptureResult.Failed(null)
            val softwareBitmap = try {
                hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false)
            } finally {
                hardwareBitmap.recycle()
            }
            val cropped = if (cropRegion != null) cropSafely(softwareBitmap, cropRegion) else softwareBitmap
            return CaptureResult.Success(downscale(cropped, longestEdgePx))
        } finally {
            hardwareBuffer.close()
        }
    }

    /**
     * True when a [captureDownscaled] call right now would drop the frame at
     * the throttle floor. Exposed so the cascade can ask this cheap question
     * *before* paying for work whose only consumer is the capture itself
     * (the accessibility-tree walk in particular - see
     * ContentGuardService.processFrame's pre-scan gate).
     */
    fun wouldThrottle(): Boolean = SystemClock.elapsedRealtime() - lastCaptureAt < prefs.captureThrottleMs

    /** Carries the platform's error code out of the callback, which a plain nullable result discarded. */
    private sealed interface ScreenshotAttempt {
        class Ok(val result: ScreenshotResult) : ScreenshotAttempt
        class Error(val errorCode: Int) : ScreenshotAttempt
    }

    /**
     * Found from a real-device report: keyword blocking and NSFW blocking
     * (both only reachable through ContentGuardService.processFrame, fed by
     * its single consumeFrames consumer coroutine) went permanently dead
     * while everything evaluated directly in onAccessibilityEvent - the
     * settings-guard password prompt, incognito's title check - kept working
     * fine for the rest of the process's life. That specific split, with no
     * crash and no service teardown anywhere in the log, points at exactly
     * one place: this suspendCancellableCoroutine had no timeout, so if the
     * platform ever fails to invoke *either* TakeScreenshotCallback method
     * for a given takeScreenshot() call - plausible on an OEM skin under
     * whatever background-management pressure killed the callback - the
     * coroutine suspends forever. Since this is the only thing consumeFrames
     * is ever suspended on inside processFrame, that one lost callback
     * permanently wedges the sole consumer of frameChannel: every request
     * after it sits unread on the CONFLATED channel forever, and every gate
     * downstream of capture (4B's placement notwithstanding - see below)
     * stops firing for good, silently, with nothing to log because nothing
     * ever throws.
     *
     * withTimeoutOrNull bounds the wait instead: generous enough (well over
     * any real capture, which normally completes in well under a second) to
     * never fire on a merely slow device, but finite, so a lost callback
     * becomes an ordinary CaptureResult.Failed - same as any other refusal -
     * instead of an unrecoverable, undetectable hang. A callback that
     * eventually does arrive after the timeout is a safe no-op: cont.isActive
     * is false once withTimeoutOrNull has cancelled it, so both resume calls
     * below simply skip.
     */
    private suspend fun takeScreenshotSuspending(): ScreenshotAttempt {
        val attempt = withTimeoutOrNull(SCREENSHOT_CALLBACK_TIMEOUT_MS) {
            suspendCancellableCoroutine { cont ->
                service.takeScreenshot(
                    Display.DEFAULT_DISPLAY,
                    callbackExecutor,
                    object : TakeScreenshotCallback {
                        override fun onSuccess(result: ScreenshotResult) {
                            if (cont.isActive) cont.resume(ScreenshotAttempt.Ok(result), onCancellation = null)
                        }

                        override fun onFailure(errorCode: Int) {
                            // Happens whenever ColorOS itself rate-limits or denies
                            // the call - see accessibility_service_config.xml. The
                            // code is now carried out to the caller rather than
                            // only reaching logcat, so the Debug log can name it.
                            Log.d(TAG, "takeScreenshot failed: errorCode=$errorCode")
                            if (cont.isActive) cont.resume(ScreenshotAttempt.Error(errorCode), onCancellation = null)
                        }
                    },
                )
            }
        }
        if (attempt != null) return attempt
        Log.w(TAG, "takeScreenshot callback never fired within ${SCREENSHOT_CALLBACK_TIMEOUT_MS}ms - treating as failed")
        return ScreenshotAttempt.Error(ERROR_TAKESCREENSHOT_CALLBACK_TIMEOUT)
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

        // Was a hardcoded constant here - history: 900ms (near platform
        // floor) -> 1500ms (battery) -> 900ms (explicit "fast as possible"
        // request) -> 1800ms (once the pixel-based skin-region crop made
        // per-frame detection reliable enough that a slower cadence only
        // costs latency, not whether content gets caught). Now
        // PrefsRepository.captureThrottleMs, user-tunable from Settings
        // instead of another manual retune - see
        // PrefsRepository.DEFAULT_CAPTURE_THROTTLE_MS for the current
        // default (still 1800ms) and MIN/MAX for the slider's range.

        const val TARGET_LONGEST_EDGE = 640

        // See takeScreenshotSuspending's doc comment. Generous relative to a
        // real capture (normally well under 1s even on a loaded device) so
        // this can never false-positive on ordinary slowness - it exists
        // purely to bound the one failure mode that isn't ordinary slowness
        // at all: the platform never calling back.
        private const val SCREENSHOT_CALLBACK_TIMEOUT_MS = 10_000L

        // Deliberately outside AccessibilityService's own ERROR_TAKE_SCREENSHOT_*
        // range (small positive ints) so GATE5_CAPTURE_FAILED errorCode=...
        // in the Debug log unambiguously names *this* failure - a lost
        // callback - rather than looking like an OS-reported error code.
        private const val ERROR_TAKESCREENSHOT_CALLBACK_TIMEOUT = -1
    }
}
