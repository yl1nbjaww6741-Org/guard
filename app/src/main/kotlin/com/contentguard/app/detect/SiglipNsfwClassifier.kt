package com.contentguard.app.detect

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import kotlin.math.exp

/** Confirmed id2label order from prithivMLmods/siglip2-mini-explicit-content's own config (not assumed). */
enum class SiglipClass(val index: Int, val label: String) {
    ANIME_PICTURE(0, "Anime Picture"),
    ENTICING_AND_SENSUAL(1, "Enticing & Sensual"),
    HENTAI(2, "Hentai"),
    PORNOGRAPHY(3, "Pornography"),
    SAFE_FOR_WORK(4, "Safe for Work"),
}

/**
 * Gate 7 backend for prithivMLmods/siglip2-mini-explicit-content, run via
 * ONNX Runtime Mobile with NNAPI preferred - confirmed actually engaging
 * on real hardware (Find X9 Pro, ~148ms avg per inference) rather than
 * silently falling back to CPU, per the NNAPI-engagement spike this
 * class supersedes. Falls back to CPU automatically if NNAPI init fails
 * on a given device, same pattern as OnnxNsfwClassifier.
 *
 * Unlike a single sfw/nsfw score, this model's 5-class softmax (Anime
 * Picture, Enticing & Sensual, Hentai, Pornography, Safe for Work)
 * separates "sexy" (Enticing & Sensual) from actual explicit content -
 * [classPolicies] is a per-class probability threshold map deciding
 * which classes actually gate blocking. Currently blocking all three of
 * Pornography, Hentai, and Enticing & Sensual (0.7 each) - Safe for Work
 * and Anime Picture are logged on every inference (for visibility while
 * tuning) but never contribute to the returned score. This is a
 * temporary, easily-reversed choice: to stop blocking Enticing & Sensual
 * later, just delete its line from DEFAULT_CLASS_POLICIES below (or pass
 * a different map to the constructor) - nothing else needs to change.
 *
 * scoreNsfw() returns max(classProb / classThreshold) across
 * [classPolicies] - a ratio >= 1.0 means some class's own threshold was
 * met, which will always trip the cascade's global nsfwThreshold
 * comparison in ContentGuardService (that slider tops out at 1.0)
 * regardless of where the user has it set. This makes per-class
 * thresholds authoritative for the block decision, while the existing
 * global slider still works as an overall sensitivity multiplier rather
 * than fighting the per-class logic.
 */
class SiglipNsfwClassifier(
    context: Context,
    modelAssetPath: String,
    private val classPolicies: Map<SiglipClass, Float> = DEFAULT_CLASS_POLICIES,
) : NsfwClassifier {

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val inputName: String
    private val outputName: String
    private val inputSize: Int
    val executionProvider: ExecutionProvider

    init {
        val modelBytes = context.assets.open(modelAssetPath).use { it.readBytes() }
        val (createdSession, ep) = createSession(modelBytes)
        session = createdSession
        executionProvider = ep
        inputName = session.inputNames.first()
        outputName = session.outputNames.first()

        val inputShape = (session.inputInfo.getValue(inputName).info as TensorInfo).shape
        // Confirmed square (224x224) for this model - read from the model
        // itself rather than hardcoding, in case a different export changes it.
        inputSize = inputShape.getOrElse(2) { 224L }.let { if (it <= 0) 224L else it }.toInt()

        Log.i(
            TAG,
            "session ready: model=$modelAssetPath executionProvider=$executionProvider " +
                "inputSize=${inputSize}x$inputSize classPolicies=$classPolicies",
        )
    }

    private fun createSession(modelBytes: ByteArray): Pair<OrtSession, ExecutionProvider> {
        OrtSession.SessionOptions().use { nnapiOptions ->
            try {
                nnapiOptions.addNnapi()
                return env.createSession(modelBytes, nnapiOptions) to ExecutionProvider.NNAPI
            } catch (e: OrtException) {
                Log.w(TAG, "NNAPI EP init failed, falling back to CPU EP", e)
            }
        }
        OrtSession.SessionOptions().apply { setIntraOpNumThreads(2) }.use { cpuOptions ->
            return env.createSession(modelBytes, cpuOptions) to ExecutionProvider.CPU
        }
    }

    override fun scoreNsfw(bitmap: Bitmap): Float {
        val probs = runInference(bitmap)

        SiglipClass.entries.forEach { Log.d(TAG, "class=${it.label} prob=${probs[it.index]}") }

        var maxRatio = 0f
        for ((siglipClass, threshold) in classPolicies) {
            if (threshold <= 0f) continue
            val ratio = probs[siglipClass.index] / threshold
            if (ratio > maxRatio) maxRatio = ratio
        }
        return maxRatio
    }

    private fun runInference(bitmap: Bitmap): FloatArray {
        // Same NCHW/mean-0.5/std-0.5 preprocessing recipe as the other ONNX
        // ViT model - only the (confirmed, not assumed) size differs.
        val inputBuffer = ViTPreprocessor.toNchwBuffer(bitmap, inputSize)
        val shape = longArrayOf(1, 3, inputSize.toLong(), inputSize.toLong())

        val startNanos = System.nanoTime()
        val logits = OnnxTensor.createTensor(env, inputBuffer, shape).use { tensor ->
            session.run(mapOf(inputName to tensor)).use { results ->
                @Suppress("UNCHECKED_CAST")
                (results.get(outputName).get().value as Array<FloatArray>)[0]
            }
        }
        val elapsedMs = (System.nanoTime() - startNanos) / 1_000_000
        val probs = softmax(logits)
        Log.d(TAG, "inference: ep=$executionProvider latencyMs=$elapsedMs")
        return probs
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
        private const val TAG = "SiglipNsfwClassifier"

        // Delete the ENTICING_AND_SENSUAL line below to stop blocking
        // "sexy" content and only block actual explicit content again.
        val DEFAULT_CLASS_POLICIES: Map<SiglipClass, Float> = mapOf(
            SiglipClass.PORNOGRAPHY to 0.7f,
            SiglipClass.HENTAI to 0.7f,
            SiglipClass.ENTICING_AND_SENSUAL to 0.7f,
        )
    }
}
