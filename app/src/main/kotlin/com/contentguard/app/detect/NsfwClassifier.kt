package com.contentguard.app.detect

import android.graphics.Bitmap

/** Gate 7 of the cascade - the expensive, rare one. */
interface NsfwClassifier {

    /**
     * Returns a 0f (safe) .. 1f (nsfw) score for the given crop.
     * [packageName] is optional context (for backends that log per-frame
     * detections against their source app, e.g. NudeNetDetector) - purely
     * informational, never affects the score itself.
     */
    fun scoreNsfw(bitmap: Bitmap, packageName: String? = null): Float

    /**
     * What drove the most recent [scoreNsfw] call, for the block log line -
     * e.g. NudeNetDetector's "BUTTOCKS_EXPOSED=0.53 box=..." - so a false
     * positive can be diagnosed from the Debug log without verbose logging
     * having been on at the time. Null when a backend has nothing to add.
     */
    fun lastDecisionDetail(): String? = null

    /**
     * How confident the most recent [scoreNsfw] call's block decision was,
     * 0..1. For a backend whose score is already a probability this is the
     * score itself; NudeNetDetector's score is binary, so it reports the
     * highest-scoring detection that triggered the block. Drives whether
     * ContentGuardService takes a confirming second look before blocking.
     */
    fun lastBlockConfidence(lastScore: Float): Float = lastScore

    /** Release native resources (interpreter, delegate). Safe to call more than once. */
    fun close() {}
}

/** Used whenever no gate-7 model asset is present - always scores 0, never blocks. */
class StubNsfwClassifier : NsfwClassifier {
    override fun scoreNsfw(bitmap: Bitmap, packageName: String?): Float = 0f
}
