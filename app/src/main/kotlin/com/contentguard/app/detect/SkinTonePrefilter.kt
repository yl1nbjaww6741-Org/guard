package com.contentguard.app.detect

import android.graphics.Bitmap
import android.graphics.Rect
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Gate 6 of the cascade. A tiny downscale + RGB rule is orders of
 * magnitude cheaper than even the smallest CNN forward pass, so this
 * exists purely to keep gate 7 asleep on screens with no skin-range
 * colour at all (most text/UI screens that still happen to contain an
 * ImageView, e.g. an icon).
 *
 * [analyze] does more than a single global yes/no ratio: it buckets skin
 * pixels into a coarse grid and returns the bounding region of wherever
 * skin is actually concentrated, not just whether any exists. This exists
 * because real-world testing found the accessibility-tree-based crop
 * (NodeInspector/ScreenCapturer's cropRegion) fundamentally can't be made
 * reliable across every app/framework - a Reddit post or a webpage
 * typically surrounds the actual photo with real UI chrome (header/
 * toolbar, username/title text, vote/comment buttons, even the next
 * post already peeking in), sometimes plus black letterboxing bars
 * around the photo itself. That chrome dilutes the classifier's
 * confidence for a genuinely explicit photo down toward (or below) the
 * detection threshold, exactly the same way regardless of whether the
 * content is native Compose UI or a rendered webpage - so instead of
 * chasing framework-specific accessibility quirks indefinitely, this
 * finds the actual explicit region directly from pixels, which works
 * identically no matter what drew them.
 *
 * Deliberately permissive/recall-biased: a false pass here just costs one
 * extra CNN inference; a false reject here is a missed detection with no
 * recourse. Tune the thresholds down (more CNN runs) if you see misses,
 * not up.
 */
object SkinTonePrefilter {

    // Analysis happens on a small downscale for speed, then the resulting
    // region is scaled back up to the source bitmap's own coordinates.
    private const val ANALYSIS_SIZE = 64
    private const val GRID_SIZE = 8
    private const val CELL_SIZE = ANALYSIS_SIZE / GRID_SIZE
    private const val CELL_SKIN_THRESHOLD = 0.15f

    data class SkinRegionResult(
        val hasSkin: Boolean,
        /** In [bitmap]'s own coordinate space, with padding already applied. Null if hasSkin is false. */
        val region: Rect?,
    )

    fun analyze(bitmap: Bitmap): SkinRegionResult {
        val small = Bitmap.createScaledBitmap(bitmap, ANALYSIS_SIZE, ANALYSIS_SIZE, false)
        try {
            val pixels = IntArray(ANALYSIS_SIZE * ANALYSIS_SIZE)
            small.getPixels(pixels, 0, ANALYSIS_SIZE, 0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE)

            val hot = Array(GRID_SIZE) { BooleanArray(GRID_SIZE) }
            var anyHot = false

            for (gy in 0 until GRID_SIZE) {
                for (gx in 0 until GRID_SIZE) {
                    var skinCount = 0
                    for (dy in 0 until CELL_SIZE) {
                        for (dx in 0 until CELL_SIZE) {
                            val p = pixels[(gy * CELL_SIZE + dy) * ANALYSIS_SIZE + (gx * CELL_SIZE + dx)]
                            val r = (p shr 16) and 0xFF
                            val g = (p shr 8) and 0xFF
                            val b = p and 0xFF
                            if (isSkinPixel(r, g, b)) skinCount++
                        }
                    }
                    if (skinCount.toFloat() / (CELL_SIZE * CELL_SIZE) >= CELL_SKIN_THRESHOLD) {
                        hot[gy][gx] = true
                        anyHot = true
                    }
                }
            }

            if (!anyHot) return SkinRegionResult(hasSkin = false, region = null)

            var minGx = GRID_SIZE
            var maxGx = -1
            var minGy = GRID_SIZE
            var maxGy = -1
            for (gy in 0 until GRID_SIZE) {
                for (gx in 0 until GRID_SIZE) {
                    if (hot[gy][gx]) {
                        if (gx < minGx) minGx = gx
                        if (gx > maxGx) maxGx = gx
                        if (gy < minGy) minGy = gy
                        if (gy > maxGy) maxGy = gy
                    }
                }
            }

            // One cell of padding on each side so the crop doesn't cut tight
            // against the subject's own edge.
            val gxStart = (minGx - 1).coerceAtLeast(0)
            val gyStart = (minGy - 1).coerceAtLeast(0)
            val gxEnd = (maxGx + 2).coerceAtMost(GRID_SIZE)
            val gyEnd = (maxGy + 2).coerceAtMost(GRID_SIZE)

            val scaleX = bitmap.width.toFloat() / ANALYSIS_SIZE
            val scaleY = bitmap.height.toFloat() / ANALYSIS_SIZE

            val region = Rect(
                (gxStart * CELL_SIZE * scaleX).toInt(),
                (gyStart * CELL_SIZE * scaleY).toInt(),
                (gxEnd * CELL_SIZE * scaleX).toInt().coerceAtMost(bitmap.width),
                (gyEnd * CELL_SIZE * scaleY).toInt().coerceAtMost(bitmap.height),
            )
            return SkinRegionResult(hasSkin = true, region = region)
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
