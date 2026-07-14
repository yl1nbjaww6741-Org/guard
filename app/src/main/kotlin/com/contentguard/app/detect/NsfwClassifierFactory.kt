package com.contentguard.app.detect

import android.content.Context
import android.util.Log
import java.io.IOException

object NsfwClassifierFactory {

    const val MODEL_ASSET = "nsfw.tflite"
    private const val TAG = "NsfwClassifierFactory"

    fun create(context: Context): NsfwClassifier {
        val hasModel = try {
            context.assets.open(MODEL_ASSET).close()
            true
        } catch (e: IOException) {
            false
        }

        if (!hasModel) {
            Log.i(TAG, "assets/$MODEL_ASSET not present - using StubNsfwClassifier (gate 7 always scores 0)")
            return StubNsfwClassifier()
        }

        return try {
            TFLiteNsfwClassifier(context, MODEL_ASSET)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load $MODEL_ASSET, falling back to stub", e)
            StubNsfwClassifier()
        }
    }
}
