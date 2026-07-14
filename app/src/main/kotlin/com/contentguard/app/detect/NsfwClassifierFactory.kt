package com.contentguard.app.detect

import android.content.Context
import android.util.Log
import java.io.IOException

object NsfwClassifierFactory {

    const val SIGLIP_MODEL_ASSET = "siglip2_nsfw.onnx"
    const val ONNX_MODEL_ASSET = "nsfw.onnx"
    const val TFLITE_MODEL_ASSET = "nsfw.tflite"
    private const val TAG = "NsfwClassifierFactory"

    /**
     * Prefers assets/siglip2_nsfw.onnx (SiglipNsfwClassifier - separates
     * "sexy" from real nudity, NNAPI-accelerated, confirmed engaging on
     * real hardware), then falls back to the legacy assets/nsfw.onnx
     * (OnnxNsfwClassifier) and assets/nsfw.tflite (TFLiteNsfwClassifier) in
     * that order if only those are present, so swapping the model file is
     * the only thing needed to change backends - no caller-side changes.
     */
    fun create(context: Context): NsfwClassifier {
        if (assetExists(context, SIGLIP_MODEL_ASSET)) {
            try {
                return SiglipNsfwClassifier(context, SIGLIP_MODEL_ASSET)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load $SIGLIP_MODEL_ASSET, falling back", e)
            }
        }

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

        Log.i(TAG, "no NSFW model assets found - using StubNsfwClassifier (gate 7 always scores 0)")
        return StubNsfwClassifier()
    }

    private fun assetExists(context: Context, path: String): Boolean = try {
        context.assets.open(path).close()
        true
    } catch (e: IOException) {
        false
    }
}
