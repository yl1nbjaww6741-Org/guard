package com.contentguard.app.detect

import android.graphics.Bitmap

/** Gate 7 of the cascade - the expensive, rare one. */
interface NsfwClassifier {

    /** Returns a 0f (safe) .. 1f (nsfw) score for the given crop. */
    fun scoreNsfw(bitmap: Bitmap): Float

    /** Release native resources (interpreter, delegate). Safe to call more than once. */
    fun close() {}
}

/** Used whenever assets/nsfw.tflite is absent - always scores 0, never blocks. */
class StubNsfwClassifier : NsfwClassifier {
    override fun scoreNsfw(bitmap: Bitmap): Float = 0f
}
