package com.contentguard.app.detect

import android.content.Context
import android.util.Log
import java.io.IOException

object NsfwClassifierFactory {

    const val ONNX_MODEL_ASSET = "nsfw.onnx"
    const val TFLITE_MODEL_ASSET = "nsfw.tflite"
    private const val TAG = "NsfwClassifierFactory"

    /**
     * Prefers assets/nsfw.onnx (OnnxNsfwClassifier, NNAPI-accelerated) and
     * falls back to the legacy assets/nsfw.tflite (TFLiteNsfwClassifier) if
     * only that's present, so swapping the model file is the only thing
     * needed to change backends - no caller-side changes.
     */
    fun create(context: Context): NsfwClassifier {
        if (assetExists(context, ONNX_MODEL_ASSET)) {
            try {
                return OnnxNsfwClassifier(context, ONNX_MODEL_ASSET)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load $ONNX_MODEL_ASSET, falling back", e)
            }
        }

        if (assetExists(context, TFLITE_MODEL_ASSET)) {
            return try {
                TFLiteNsfwClassifier(context, TFLITE_MODEL_ASSET)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load $TFLITE_MODEL_ASSET, falling back to stub", e)
                StubNsfwClassifier()
            }
        }

        Log.i(TAG, "no $ONNX_MODEL_ASSET or $TFLITE_MODEL_ASSET in assets - using StubNsfwClassifier (gate 7 always scores 0)")
        return StubNsfwClassifier()
    }

    private fun assetExists(context: Context, path: String): Boolean = try {
        context.assets.open(path).close()
        true
    } catch (e: IOException) {
        false
    }
}
