package com.contentguard.app.detect

import android.graphics.Bitmap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Gate 6 of the cascade. A 24x24 downscale + RGB rule is orders of
 * magnitude cheaper than even the smallest CNN forward pass, so this
 * exists purely to keep gate 7 asleep on screens with no skin-range
 * colour at all (most text/UI screens that still happen to contain an
 * ImageView, e.g. an icon).
 *
 * Deliberately permissive/recall-biased: a false pass here just costs one
 * extra CNN inference; a false reject here is a missed detection with no
 * recourse. Tune SKIN_FRACTION_THRESHOLD down (more CNN runs) if you see
 * misses, not up.
 */
object SkinTonePrefilter {

    private const val TARGET_SIZE = 24
    private const val SKIN_FRACTION_THRESHOLD = 0.10f

    fun looksSkinLike(bitmap: Bitmap): Boolean {
        val small = Bitmap.createScaledBitmap(bitmap, TARGET_SIZE, TARGET_SIZE, false)
        try {
            val total = TARGET_SIZE * TARGET_SIZE
            val pixels = IntArray(total)
            small.getPixels(pixels, 0, TARGET_SIZE, 0, 0, TARGET_SIZE, TARGET_SIZE)

            var skinPixels = 0
            for (p in pixels) {
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                if (isSkinPixel(r, g, b)) skinPixels++
            }
            return skinPixels.toFloat() / total >= SKIN_FRACTION_THRESHOLD
        } finally {
            if (small !== bitmap) small.recycle()
        }
    }

    // Kovac et al. RGB skin-detection rule (daylight + flash/indoor variants).
    private fun isSkinPixel(r: Int, g: Int, b: Int): Boolean {
        val maxC = max(r, max(g, b))
        val minC = min(r, min(g, b))
        val spread = maxC - minC

        val daylight = r > 95 && g > 40 && b > 20 &&
            spread > 15 && abs(r - g) > 15 && r > g && r > b

        val flash = r > 220 && g > 210 && b > 170 &&
            abs(r - g) <= 15 && r > b && g > b

        return daylight || flash
    }
}
