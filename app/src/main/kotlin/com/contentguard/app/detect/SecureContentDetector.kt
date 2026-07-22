package com.contentguard.app.detect

import android.graphics.Bitmap
import kotlin.math.sqrt

/**
 * Structural complement to [IncognitoDetector]'s keyword matching - not a
 * replacement. Android renders any window with WindowManager.LayoutParams
 * .FLAG_SECURE as flat black to every capture path (screenshots, screen
 * recording, AccessibilityService.takeScreenshot alike), platform-wide,
 * regardless of what that window's own UI actually says. Browsers set this
 * flag on private/incognito tabs specifically to block capture - so unlike
 * TITLE_KEYWORDS/CONTENT_KEYWORDS, this doesn't depend on recognizing any
 * particular browser's wording, or having ever seen that browser before.
 *
 * Deliberately requires both very low brightness AND very low variance, not
 * just "dark" - an ordinary dark-themed page still has real text/icon/
 * border variation even in a pure black theme; a genuine FLAG_SECURE
 * cutout is perfectly flat since nothing real was ever rendered into it.
 */
object SecureContentDetector {

    // Small downscale for speed, matching SkinTonePrefilter's approach -
    // correctness here doesn't need every source pixel, just a
    // representative sample of the frame's overall brightness/uniformity.
    private const val ANALYSIS_SIZE = 32

    private const val MAX_AVG_LUMA = 6.0
    private const val MAX_STD_DEV = 4.0

    data class Result(val looksSecureBlocked: Boolean, val avgLuma: Double, val stdDev: Double)

    fun analyze(bitmap: Bitmap): Result {
        val small = Bitmap.createScaledBitmap(bitmap, ANALYSIS_SIZE, ANALYSIS_SIZE, false)
        try {
            val pixels = IntArray(ANALYSIS_SIZE * ANALYSIS_SIZE)
            small.getPixels(pixels, 0, ANALYSIS_SIZE, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)

            var sum = 0.0
            var sumSq = 0.0
            for (p in pixels) {
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                val luma = 0.299 * r + 0.587 * g + 0.114 * b
                sum += luma
                sumSq += luma * luma
            }
            val avg = sum / pixels.size
            val variance = (sumSq / pixels.size) - (avg * avg)
            val stdDev = sqrt(variance.coerceAtLeast(0.0))
            return Result(avg <= MAX_AVG_LUMA && stdDev <= MAX_STD_DEV, avg, stdDev)
        } finally {
            if (small !== bitmap) small.recycle()
        }
    }
}
