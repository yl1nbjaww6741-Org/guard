package com.contentguard.app

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.nio.FloatBuffer
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PART 2: THROWAWAY SPIKE - not wired into the app, not a correctness
 * test, not meant to be kept around once it's answered its question.
 *
 * Exists purely to answer one thing before any real integration work
 * starts: does ONNX Runtime's NNAPI execution provider actually engage
 * for the quantized SigLIP2 model on real hardware, or does it silently
 * fall back to CPU? SigLIP2 is a vision transformer; NNAPI's op coverage
 * was designed around CNNs, so unlike the earlier ViT-based classifier
 * (already confirmed heavily CPU-partitioned per OnnxNsfwClassifier's own
 * doc comment), this is worth measuring fresh rather than assuming either
 * way.
 *
 * Setup: place the quantized model produced by
 * tools/export_siglip_onnx.py at
 * app/src/main/assets/siglip_quantized_spike.onnx - a name distinct from
 * nsfw.onnx/nsfw.tflite on purpose, so NsfwClassifierFactory does not
 * pick this up. Nothing here should reach the real cascade until Part 3
 * is explicitly authorized.
 *
 * Run: ./gradlew connectedAndroidTest
 *   (needs a connected device/emulator via adb - same as everything else
 *   in this project that touches real hardware, this cannot run in a
 *   sandbox with no Android device attached)
 *
 * Read the answer from logcat (tag "NnapiEngagementSpike"), not from the
 * test's pass/fail status - the assertions only check the pipeline ran
 * end to end without throwing. The actual answer - which execution
 * provider engaged, and per-inference latency - is in the log lines.
 */
@RunWith(AndroidJUnit4::class)
class NnapiEngagementSpikeTest {

    @Test
    fun measureNnapiEngagementAndLatency() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val env = OrtEnvironment.getEnvironment()
        val modelBytes = context.assets.open(MODEL_ASSET).use { it.readBytes() }

        val (session, engagedProvider) = createSessionPreferringNnapi(env, modelBytes)
        Log.i(TAG, "session created, executionProvider=$engagedProvider")

        session.use { ortSession ->
            val inputName = ortSession.inputNames.first()
            val outputName = ortSession.outputNames.first()

            // Read the model's own reported input shape rather than
            // assuming 512x512 - same "verify, don't assume" discipline
            // as tools/export_siglip_onnx.py applies on the Python side.
            val inputTensorInfo = ortSession.inputInfo.getValue(inputName).info as TensorInfo
            val shape = inputTensorInfo.shape
            val channels = shape.getOrElse(1) { 3L }.let { if (it <= 0) 3L else it }.toInt()
            val height = shape.getOrElse(2) { 512L }.let { if (it <= 0) 512L else it }.toInt()
            val width = shape.getOrElse(3) { 512L }.let { if (it <= 0) 512L else it }.toInt()
            Log.i(TAG, "model reports input shape (with dynamic dims resolved): [1, $channels, $height, $width]")

            val latenciesMs = mutableListOf<Long>()
            repeat(SAMPLE_COUNT) { i ->
                // Synthetic bitmaps: this spike measures EP engagement and
                // latency only, not classification correctness (Part 1's
                // Python-side sanity check already covers accuracy), so
                // pixel content doesn't matter here, only shape does.
                val bitmap = syntheticBitmap(width, height, seed = i)
                val inputBuffer = toNchwBuffer(bitmap, channels, height, width)
                val tensorShape = longArrayOf(1, channels.toLong(), height.toLong(), width.toLong())

                val startNanos = System.nanoTime()
                OnnxTensor.createTensor(env, inputBuffer, tensorShape).use { tensor ->
                    ortSession.run(mapOf(inputName to tensor)).use { /* engagement/latency spike - output discarded */ }
                }
                val elapsedMs = (System.nanoTime() - startNanos) / 1_000_000
                latenciesMs.add(elapsedMs)
                Log.i(TAG, "sample $i: latencyMs=$elapsedMs")
                bitmap.recycle()
            }

            Log.i(
                TAG,
                "RESULT: executionProvider=$engagedProvider " +
                    "latenciesMs=$latenciesMs avgMs=${latenciesMs.average()} outputName=$outputName",
            )
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

    companion object {
        private const val TAG = "NnapiEngagementSpike"
        private const val MODEL_ASSET = "siglip_quantized_spike.onnx"
        private const val SAMPLE_COUNT = 5
    }
}
