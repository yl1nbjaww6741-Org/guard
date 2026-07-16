package com.contentguard.app.detect

import android.content.Context
import android.util.Log
import java.io.IOException

object NsfwClassifierFactory {

    const val NUDENET_MODEL_ASSET = NudeNetDetector.ASSET_NAME
    const val ONNX_MODEL_ASSET = "nsfw.onnx"
    const val TFLITE_MODEL_ASSET = "nsfw.tflite"
    private const val TAG = "NsfwClassifierFactory"

    /**
     * Prefers assets/320n.onnx (NudeNetDetector - label-set body-part
     * detection gate, see its class doc for why this replaced the old
     * whole-image SigLIP2 classifier), then falls back to the legacy
     * assets/nsfw.onnx (OnnxNsfwClassifier) and assets/nsfw.tflite
     * (TFLiteNsfwClassifier) in that order if only those are present, so
     * swapping the model file is the only thing needed to change backends
     * - no caller-side changes.
     */
    fun create(context: Context): NsfwClassifier {
        if (assetExists(context, NUDENET_MODEL_ASSET)) {
            try {
                return NudeNetDetector(context, NUDENET_MODEL_ASSET)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load $NUDENET_MODEL_ASSET, falling back", e)
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
