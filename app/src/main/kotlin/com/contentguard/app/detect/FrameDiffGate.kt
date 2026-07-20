package com.contentguard.app.detect

import android.graphics.Bitmap
import android.os.SystemClock

/**
 * Inference-optimization gate: skips a redundant gate-7 classifier run when
 * the just-captured region looks like the same content as last cycle,
 * inserted between the skin-tone prefilter (gate 6) and the classifier call
 * (gate 7) in ContentGuardService.processFrame - after region capture,
 * before the classifier, per its own design brief.
 *
 * Deliberately asymmetric, because a wrong skip is not a symmetric risk for
 * a content blocker:
 *  - Last real verdict was BLOCKED and this frame looks the same -> safe to
 *    skip. Worst case: an already-blocked screen stays blocked one cycle
 *    longer than a fresh inference would have decided - over-blocking, the
 *    safe direction.
 *  - Last real verdict was CLEAR and this frame looks the same -> NOT
 *    skipped, by design (see class doc on the CLEAR branch below). This is
 *    the one case where a wrong skip would mean genuinely new content (a
 *    carousel auto-advancing, a video frame changing) sliding through
 *    without ever being scored - the failure mode this whole app exists to
 *    avoid. Always re-runs the real classifier here instead.
 *
 * Similarity is judged with a dHash (difference hash - Krawetz's classic
 * perceptual-hash construction: downscale, compare adjacent pixels, no FFT/
 * DCT needed) rather than an exact pixel/byte comparison, because the
 * accessibility-tree-derived crop region drifts a few px cycle to cycle on
 * genuinely identical content (sub-pixel layout jitter, rounding in
 * NodeInspector's bounds), which would defeat an exact-match comparison
 * outright. Normalizing to a fixed size before hashing absorbs that drift.
 *
 * Per-package cache (like PrefsRepository's per-package strikes/lockouts):
 * different monitored apps have entirely independent "is the screen static"
 * state, so a hash from one app must never be compared against another's.
 */
class FrameDiffGate {

    /** What the caller should do about the frame that was just captured. */
    data class GateOutcome(
        val skip: Boolean,
        val hammingDistance: Int,
        val skipCount: Int,
    )

    private enum class Verdict { CLEAR, BLOCKED }

    private data class CachedFrame(
        val hash: Long,
        val verdict: Verdict,
        var skipCount: Int,
        var lastRealCheckAt: Long,
    )

    private val cache = mutableMapOf<String, CachedFrame>()

    /**
     * Returns an outcome with [GateOutcome.skip] true only when it's safe to
     * reuse the cached (necessarily BLOCKED) verdict instead of running the
     * real classifier. Any failure here (hashing exception, recycled/invalid
     * bitmap) fails closed - returns skip=false, exactly as if there were no
     * cache at all, so the classifier still runs. A gate error must never be
     * the reason content goes unscored.
     */
    fun evaluate(
        pkg: String,
        bitmap: Bitmap,
        hammingThreshold: Int,
        maxSkipCount: Int,
        maxSkipAgeMs: Long,
    ): GateOutcome {
        return try {
            evaluateInternal(pkg, bitmap, hammingThreshold, maxSkipCount, maxSkipAgeMs)
        } catch (e: Exception) {
            GateOutcome(skip = false, hammingDistance = -1, skipCount = 0)
        }
    }

    private fun evaluateInternal(
        pkg: String,
        bitmap: Bitmap,
        hammingThreshold: Int,
        maxSkipCount: Int,
        maxSkipAgeMs: Long,
    ): GateOutcome {
        val cached = cache[pkg] ?: return GateOutcome(skip = false, hammingDistance = -1, skipCount = 0)

        val hash = computeDHash(bitmap)
        val distance = java.lang.Long.bitCount(cached.hash xor hash)
        val similar = distance <= hammingThreshold
        val now = SystemClock.elapsedRealtime()
        val forcedRefreshDue = cached.skipCount >= maxSkipCount || (now - cached.lastRealCheckAt) >= maxSkipAgeMs

        // Only ever skip on the BLOCKED branch - see class doc for why the
        // CLEAR branch always falls through to a real classifier run
        // regardless of similarity.
        val canSkip = !forcedRefreshDue && similar && cached.verdict == Verdict.BLOCKED
        if (canSkip) {
            cached.skipCount++
        }
        return GateOutcome(skip = canSkip, hammingDistance = distance, skipCount = cached.skipCount)
    }

    /**
     * Call after every real classifier run (never after a skip) to record
     * what it decided, so the next cycle has something to compare against.
     * Silently drops the cache entry on failure rather than caching garbage
     * - equivalent to there being no prior frame, which is always the safe
     * (never-skip) state.
     */
    fun recordRealResult(pkg: String, bitmap: Bitmap, blocked: Boolean) {
        try {
            val hash = computeDHash(bitmap)
            cache[pkg] = CachedFrame(
                hash = hash,
                verdict = if (blocked) Verdict.BLOCKED else Verdict.CLEAR,
                skipCount = 0,
                lastRealCheckAt = SystemClock.elapsedRealtime(),
            )
        } catch (e: Exception) {
            cache.remove(pkg)
        }
    }

    /**
     * dHash: normalize to [NORMALIZE_SIZE]x[NORMALIZE_SIZE] first (the
     * resize filter's own blur absorbs a few px of crop-boundary jitter
     * between cycles on otherwise-identical content), then downscale that
     * to a [HASH_WIDTH]x[HASH_HEIGHT] grayscale grid and compare each pixel
     * to its right neighbor - (HASH_WIDTH-1)*HASH_HEIGHT = 64 bits, one Long.
     */
    private fun computeDHash(bitmap: Bitmap): Long {
        val normalized = Bitmap.createScaledBitmap(bitmap, NORMALIZE_SIZE, NORMALIZE_SIZE, true)
        try {
            val hashSource = Bitmap.createScaledBitmap(normalized, HASH_WIDTH, HASH_HEIGHT, true)
            try {
                var hash = 0L
                var bit = 0
                for (y in 0 until HASH_HEIGHT) {
                    for (x in 0 until HASH_WIDTH - 1) {
                        val left = luminance(hashSource.getPixel(x, y))
                        val right = luminance(hashSource.getPixel(x + 1, y))
                        if (left > right) hash = hash or (1L shl bit)
                        bit++
                    }
                }
                return hash
            } finally {
                if (hashSource !== normalized) hashSource.recycle()
            }
        } finally {
            if (normalized !== bitmap) normalized.recycle()
        }
    }

    private fun luminance(pixel: Int): Int {
        val r = (pixel shr 16) and 0xFF
        val g = (pixel shr 8) and 0xFF
        val b = pixel and 0xFF
        return (r * 299 + g * 587 + b * 114) / 1000
    }

    companion object {
        private const val NORMALIZE_SIZE = 32
        private const val HASH_WIDTH = 9
        private const val HASH_HEIGHT = 8
    }
}
