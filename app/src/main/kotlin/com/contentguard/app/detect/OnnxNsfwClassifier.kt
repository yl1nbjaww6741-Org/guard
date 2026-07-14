package com.contentguard.app.detect

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.contentguard.app.scope.PrefsRepository
import kotlin.math.exp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Gate 7 backend for AdamCodd/vit-base-nsfw-detector, run via ONNX Runtime
 * Mobile. Session setup tries the NNAPI execution provider first (routes to
 * NPU/GPU/DSP depending on the device's NNAPI driver) and falls back to the
 * plain CPU EP if NNAPI can't be initialized at all (missing driver, API <
 * 27, etc).
 *
 * Two layers of fallback are worth knowing apart:
 *  1. Session-creation fallback (handled here in [createSession]): if
 *     `addNnapi()` + session creation throws, we rebuild the session with
 *     CPU only. [executionProvider] reflects which of these two happened.
 *  2. Per-node fallback (handled internally by ONNX Runtime, not by this
 *     class): even when the NNAPI session is created successfully, ORT
 *     partitions the graph and silently runs any node NNAPI can't cover
 *     (e.g. Erf, Where, Equal, dynamic Shape/Expand/Gather - all present in
 *     this model's graph) on the CPU EP within the *same* session. So
 *     executionProvider == NNAPI means "an NNAPI session was created", not
 *     "100% of ops ran on the NPU". ViT/transformer graphs in particular
 *     partition heavily on most NNAPI drivers, since NNAPI's op set was
 *     designed around CNNs. To see the real per-node split during testing,
 *     construct with enableVerboseOrtLogging = true and grep logcat (tag
 *     "onnxruntime") for provider/partition assignment lines.
 *
 * Model file: expects float32 NCHW `pixel_values` input, float32 `logits`
 * (2-class) output, matching model.onnx / model_fp16.onnx on the Hugging
 * Face repo (confirmed via direct graph inspection). Do NOT point this at
 * model_uint8.onnx / model_quantized.onnx / model_int8.onnx - those use
 * ORT's dynamic-quantization ops (ConvInteger/MatMulInteger/
 * DynamicQuantizeLinear), which the NNAPI EP does not know how to place, so
 * NNAPI would fall back to CPU for nearly every compute-heavy node anyway.
 * model_fp16.onnx is the recommended asset: half the file size of
 * model.onnx with the same NNAPI-coverable op set (its "fp16" weights are
 * Cast back to float32 before compute).
 */
class OnnxNsfwClassifier(
    context: Context,
    modelAssetPath: String,
    var nsfwThreshold: Float = PrefsRepository.DEFAULT_THRESHOLD,
    enableVerboseOrtLogging: Boolean = false,
) : NsfwClassifier {

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val inputName: String
    private val outputName: String
    val executionProvider: ExecutionProvider

    init {
        val modelBytes = context.assets.open(modelAssetPath).use { it.readBytes() }
        val (createdSession, ep) = createSession(modelBytes, enableVerboseOrtLogging)
        session = createdSession
        executionProvider = ep
        inputName = session.inputNames.first()
        outputName = session.outputNames.first()
        Log.i(TAG, "session ready: model=$modelAssetPath executionProvider=$executionProvider " +
            "input=$inputName output=$outputName")
    }

    private fun createSession(modelBytes: ByteArray, verbose: Boolean): Pair<OrtSession, ExecutionProvider> {
        val nnapiOptions = OrtSession.SessionOptions()
        try {
            if (verbose) nnapiOptions.setSessionLogVerbosityLevel(0)
            nnapiOptions.addNnapi()
            val session = env.createSession(modelBytes, nnapiOptions)
            return session to ExecutionProvider.NNAPI
        } catch (e: OrtException) {
            Log.w(TAG, "NNAPI EP init failed, falling back to CPU EP", e)
            nnapiOptions.close()
        }

        val cpuOptions = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(2)
            if (verbose) setSessionLogVerbosityLevel(0)
        }
        return env.createSession(modelBytes, cpuOptions) to ExecutionProvider.CPU
    }

    /** Gate 7 entry point for the existing accessibility-event cascade (ContentGuardService). */
    override fun scoreNsfw(bitmap: Bitmap): Float = runInference(bitmap).nsfwProb

    /** Richer standalone API for any direct caller that wants the full breakdown. */
    suspend fun classifyImage(bitmap: Bitmap): NsfwResult = withContext(Dispatchers.Default) {
        runInference(bitmap)
    }

    private fun runInference(bitmap: Bitmap): NsfwResult {
        val inputBuffer = ViTPreprocessor.toNchwBuffer(bitmap)
        val shape = longArrayOf(1, 3, ViTPreprocessor.INPUT_SIZE.toLong(), ViTPreprocessor.INPUT_SIZE.toLong())

        val startNanos = System.nanoTime()
        val probs = OnnxTensor.createTensor(env, inputBuffer, shape).use { tensor ->
            session.run(mapOf(inputName to tensor)).use { results ->
                @Suppress("UNCHECKED_CAST")
                val logits = (results.get(outputName).get().value as Array<FloatArray>)[0]
                softmax(logits)
            }
        }
        val elapsedMs = (System.nanoTime() - startNanos) / 1_000_000

        val nsfwProb = probs[1]
        Log.d(TAG, "inference: ep=$executionProvider latencyMs=$elapsedMs " +
            "sfw=${probs[0]} nsfw=$nsfwProb")

        return NsfwResult(
            sfwProb = probs[0],
            nsfwProb = nsfwProb,
            isNsfw = nsfwProb >= nsfwThreshold,
            executionProvider = executionProvider,
            inferenceTimeMs = elapsedMs,
        )
    }

    private fun softmax(logits: FloatArray): FloatArray {
        val max = logits.max()
        val exps = FloatArray(logits.size) { exp((logits[it] - max).toDouble()).toFloat() }
        val sum = exps.sum()
        return FloatArray(exps.size) { exps[it] / sum }
    }

    override fun close() {
        session.close()
    }

    companion object {
        private const val TAG = "OnnxNsfwClassifier"
    }
}
