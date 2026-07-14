package com.contentguard.app.detect

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Log
import java.nio.FloatBuffer

/**
 * ORIGINALLY A THROWAWAY SPIKE, kept around as a standalone diagnostic:
 * answers, on real hardware via an installed debug APK (triggered from
 * the "Run NNAPI Spike" button in SettingsActivity), whether ONNX
 * Runtime's NNAPI execution provider actually engages for the quantized
 * SigLIP2 model or silently falls back to CPU, and at what per-inference
 * latency. SigLIP2 is a vision transformer; NNAPI's op coverage was
 * designed around CNNs, so this was worth measuring rather than assuming
 * either way - confirmed NNAPI engaging at ~148ms avg on a Find X9 Pro,
 * which is what cleared SiglipNsfwClassifier for real integration. Same
 * verified ONNX Runtime API calls as
 * app/src/androidTest/.../NnapiEngagementSpikeTest.kt, just runnable
 * from an installed APK instead of `./gradlew connectedAndroidTest` -
 * handy for re-checking after a model/device change without needing a
 * test harness.
 *
 * Now reads the same asset SiglipNsfwClassifier uses
 * (NsfwClassifierFactory.SIGLIP_MODEL_ASSET) since that model is live -
 * this button just re-runs the same NNAPI-preferring session logic in
 * isolation, it doesn't touch the real cascade's classifier instance.
 *
 * Pixel content in the synthetic test bitmaps is irrelevant here - this
 * measures execution-provider engagement and latency only, not
 * classification accuracy, so preprocessing is a simple /255 scale
 * rather than the model's real (0.5, 0.5, 0.5) mean/std normalization.
 */
object SiglipNnapiSpike {

    private const val TAG = "SiglipNnapiSpike"
    private const val MODEL_ASSET = NsfwClassifierFactory.SIGLIP_MODEL_ASSET
    private const val SAMPLE_COUNT = 5

    data class Result(val executionProvider: String, val latenciesMs: List<Long>) {
        val avgMs: Double get() = latenciesMs.average()
    }

    /** Blocking - call from a background dispatcher, not the main thread. */
    fun run(context: Context): Result {
        val env = OrtEnvironment.getEnvironment()
        val modelBytes = context.assets.open(MODEL_ASSET).use { it.readBytes() }

        val (session, engagedProvider) = createSessionPreferringNnapi(env, modelBytes)
        Log.i(TAG, "session created, executionProvider=$engagedProvider")

        session.use { ortSession ->
            val inputName = ortSession.inputNames.first()
            val inputTensorInfo = ortSession.inputInfo.getValue(inputName).info as TensorInfo
            val shape = inputTensorInfo.shape
            val channels = shape.getOrElse(1) { 3L }.let { if (it <= 0) 3L else it }.toInt()
            val height = shape.getOrElse(2) { 224L }.let { if (it <= 0) 224L else it }.toInt()
            val width = shape.getOrElse(3) { 224L }.let { if (it <= 0) 224L else it }.toInt()
            Log.i(TAG, "model reports input shape (dynamic dims resolved): [1, $channels, $height, $width]")

            val latenciesMs = mutableListOf<Long>()
            repeat(SAMPLE_COUNT) { i ->
                val bitmap = syntheticBitmap(width, height, seed = i)
                val inputBuffer = toNchwBuffer(bitmap, channels, height, width)
                val tensorShape = longArrayOf(1, channels.toLong(), height.toLong(), width.toLong())

                val startNanos = System.nanoTime()
                OnnxTensor.createTensor(env, inputBuffer, tensorShape).use { tensor ->
                    ortSession.run(mapOf(inputName to tensor)).use { /* engagement/latency spike only */ }
                }
                val elapsedMs = (System.nanoTime() - startNanos) / 1_000_000
                latenciesMs.add(elapsedMs)
                Log.i(TAG, "sample $i: latencyMs=$elapsedMs")
                bitmap.recycle()
            }

            val result = Result(engagedProvider, latenciesMs)
            Log.i(
                TAG,
                "RESULT: executionProvider=${result.executionProvider} " +
                    "latenciesMs=${result.latenciesMs} avgMs=${result.avgMs}",
            )
            return result
        }
    }

    private fun createSessionPreferringNnapi(env: OrtEnvironment, modelBytes: ByteArray): Pair<OrtSession, String> {
        OrtSession.SessionOptions().use { nnapiOptions ->
            try {
                nnapiOptions.addNnapi()
                return env.createSession(modelBytes, nnapiOptions) to "NNAPI"
            } catch (e: OrtException) {
                Log.w(TAG, "NNAPI init failed, falling back to CPU", e)
            }
        }
        OrtSession.SessionOptions().use { cpuOptions ->
            return env.createSession(modelBytes, cpuOptions) to "CPU"
        }
    }

    private fun syntheticBitmap(width: Int, height: Int, seed: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.rgb((seed * 40) % 256, 128, 200))
        return bitmap
    }

    private fun toNchwBuffer(bitmap: Bitmap, channels: Int, height: Int, width: Int): FloatBuffer {
        val plane = height * width
        val pixels = IntArray(plane)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        val buffer = FloatBuffer.allocate(channels * plane)
        for (i in 0 until plane) {
            val pixel = pixels[i]
            buffer.put(i, ((pixel shr 16) and 0xFF) / 255f)
            if (channels > 1) buffer.put(plane + i, ((pixel shr 8) and 0xFF) / 255f)
            if (channels > 2) buffer.put(2 * plane + i, (pixel and 0xFF) / 255f)
        }
        return buffer
    }
}
