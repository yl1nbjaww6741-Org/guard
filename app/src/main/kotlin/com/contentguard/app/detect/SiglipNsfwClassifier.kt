package com.contentguard.app.detect

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.contentguard.app.util.DebugLogBuffer
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
 * doesn't have a separate "Nudity" class - [classPolicies] is a
 * per-class probability threshold map deciding which classes actually
 * gate blocking. All three of Pornography, Hentai, and Enticing &
 * Sensual gate blocking, at 0.45 each. Enticing & Sensual was briefly
 * removed on the theory that it only meant "sexy but not explicit," but
 * real-world testing contradicted that: confirmed full-nudity content
 * scored ~98-99% Enticing & Sensual and under 3% Pornography in the same
 * frames, meaning this model's own taxonomy evidently classifies plain
 * nudity under Enticing & Sensual and reserves Pornography for more
 * explicit sexual acts specifically - so Enticing & Sensual is back, and
 * is in fact the operative "real nudity" signal, not a separate "also
 * block sexy content" add-on. Safe for Work and Anime Picture are
 * logged on every inference (for visibility) but never gate blocking.
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

        SiglipClass.entries.forEach {
            val line = "class=${it.label} prob=${probs[it.index]}"
            Log.d(TAG, line)
            DebugLogBuffer.add(TAG, line)
        }

        var maxRatio = 0f
        for ((siglipClass, threshold) in classPolicies) {
            if (threshold <= 0f) continue
            val ratio = probs[siglipClass.index] / threshold
            if (ratio > maxRatio) maxRatio = ratio
        }
        DebugLogBuffer.add(TAG, "maxRatio=$maxRatio")
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

        // Enticing & Sensual is the operative "real nudity" signal in this
        // model's taxonomy, not a separate "sexy" add-on - see the class
        // doc comment above. Set to 0.6, above where everyday non-explicit
        // content has peaked (~0.50 in real testing) but below every
        // confirmed-nudity score seen (0.65+), for margin against false
        // positives on borderline/suggestive-but-not-nude content.
        // Pornography/Hentai stay at 0.45 (higher sensitivity - these
        // classes haven't shown the same false-positive risk).
        val DEFAULT_CLASS_POLICIES: Map<SiglipClass, Float> = mapOf(
            SiglipClass.PORNOGRAPHY to 0.45f,
            SiglipClass.HENTAI to 0.45f,
            SiglipClass.ENTICING_AND_SENSUAL to 0.6f,
        )
    }
}
