package com.contentguard.app.detect

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.util.Log
import com.contentguard.app.util.DebugLogBuffer
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min

/**
 * notAI-tech/NudeNet v3's 18-class label set, in the exact index order
 * confirmed from the model's own reference implementation
 * (nudenet/nudenet.py's `__labels` list in the notAI-tech/NudeNet PyPI
 * package, not alphabetical or guessed) - enum declaration order below is
 * load-bearing, since [NudeNetLabel.entries]'s ordinal is used directly as
 * the class index read off the model's output tensor.
 */
enum class NudeNetLabel {
    FEMALE_GENITALIA_COVERED,
    FACE_FEMALE,
    BUTTOCKS_EXPOSED,
    FEMALE_BREAST_EXPOSED,
    FEMALE_GENITALIA_EXPOSED,
    MALE_BREAST_EXPOSED,
    ANUS_EXPOSED,
    FEET_EXPOSED,
    BELLY_COVERED,
    FEET_COVERED,
    ARMPITS_COVERED,
    ARMPITS_EXPOSED,
    FACE_MALE,
    BELLY_EXPOSED,
    MALE_GENITALIA_EXPOSED,
    ANUS_COVERED,
    FEMALE_BREAST_COVERED,
    BUTTOCKS_COVERED,
}

/** One post-NMS detection: which body part, how confident, and where (in the analyzed bitmap's own coordinates). */
data class Detection(val label: NudeNetLabel, val score: Float, val box: Rect)

/**
 * Gate-7 label-set policy: a label blocks only if it's present in this map,
 * once any single detection's score exceeds its mapped threshold. Absence
 * from the map means the label never blocks regardless of score or how
 * confident the model is - this is what makes "gym clothes" (mostly
 * *_COVERED labels, maybe BELLY_EXPOSED/ARMPITS_EXPOSED) structurally
 * distinct from real nudity here, instead of relying on a single global
 * threshold to separate two classes that share the same dominant visual
 * signal (skin area + body shape).
 */
object NudeNetGatePolicy {

    /**
     * The only labels that carry real "explicit nudity" signal for this
     * gate: exposed genitalia and anus/buttocks. Deliberately excludes both
     * breast-exposed labels by default - see [NudeNetDetector]'s class doc.
     */
    val DEFAULT_BLOCK_THRESHOLDS: Map<NudeNetLabel, Float> = mapOf(
        NudeNetLabel.FEMALE_GENITALIA_EXPOSED to 0.5f,
        NudeNetLabel.MALE_GENITALIA_EXPOSED to 0.5f,
        NudeNetLabel.BUTTOCKS_EXPOSED to 0.5f,
        NudeNetLabel.ANUS_EXPOSED to 0.5f,
    )

    /**
     * Opt-in only, merge into a classifier's block thresholds after testing
     * shows the gender-misclassification false-positive rate (shirtless
     * men tagged FEMALE_BREAST_EXPOSED) is acceptable for your own usage.
     * Not included in [DEFAULT_BLOCK_THRESHOLDS].
     */
    val BREAST_EXPOSED_THRESHOLDS: Map<NudeNetLabel, Float> = mapOf(
        NudeNetLabel.FEMALE_BREAST_EXPOSED to 0.5f,
        NudeNetLabel.MALE_BREAST_EXPOSED to 0.5f,
    )
}

/**
 * Gate 7 backend: notAI-tech/NudeNet v3's 320n ONNX export (~7MB, FP32 -
 * deliberately NOT quantized, since INT8 would need a static calibration
 * set of exactly the content this app exists to avoid capturing, and
 * quantization degrades small-object recall worst of all where 320n is
 * already weakest). Run via ONNX Runtime with the XNNPACK EP (not NNAPI -
 * deprecated on Android 15 - and not the NPU, whose fixed per-call wake
 * cost dominates for tiny sporadic inferences like this cascade's), CPU EP
 * as automatic fallback if XNNPACK init fails.
 *
 * This replaces SiglipNsfwClassifier's whole-image 5-class softmax with a
 * body-part *detector*: the label set itself, not a tuned scalar threshold,
 * is what separates "gym clothes" from real nudity - e.g. gym clothes
 * mostly produce *_COVERED detections, which [NudeNetGatePolicy] never
 * blocks on regardless of confidence. See [NudeNetGatePolicy] for exactly
 * which labels gate blocking.
 *
 * Gender-misclassification caveat (why FEMALE_BREAST_EXPOSED/
 * MALE_BREAST_EXPOSED are excluded from the default block thresholds):
 * NudeNet has a documented tendency to mislabel male chests as
 * FEMALE_BREAST_EXPOSED. For a cascade that also sees a lot of sport/gym
 * content, that would make shirtless men the dominant false-positive
 * source. Both breast labels are treated as pure signal-noise by default;
 * [NudeNetGatePolicy.BREAST_EXPOSED_THRESHOLDS] exists to opt back in per
 * app instance/testing, not because the underlying detection is wrong to
 * keep around - it's excluded from the *decision*, not from the model.
 *
 * Known limitation, intentionally NOT worked around here: 320x320 is a
 * ~4x downscale from a 1272px-class screen, and YOLO's stride-8 detection
 * head needs roughly 16px at *model* resolution to fire on something,
 * which back-projects to about 64px on the real screen. Fullscreen photos/
 * video are unaffected; small feed thumbnails may go undetected. Rather
 * than guessing at a fix (tiling, upscaling, a second pass) before real
 * usage data says it's actually a problem in practice, every frame's
 * detections (or lack of them) are logged alongside the analyzed region's
 * pixel size specifically so that miss-rate can be measured later. See
 * [maybeRunTiledEscalation] for the disabled-by-default hook this would
 * plug into.
 *
 * Preprocessing/postprocessing (letterbox pad-to-square on bottom/right
 * only + resize to 320, raw un-NMS'd [1, 22, 2100] output tensor - 4 box
 * channels + 18 class channels, class-agnostic greedy NMS) all read
 * directly off notAI-tech/NudeNet's own nudenet.py reference implementation
 * and the ONNX graph's actual verified I/O, not assumed - see the class
 * indices above and the model's own confirmed output shape.
 */
class NudeNetDetector(
    context: Context,
    modelAssetPath: String = ASSET_NAME,
    private val blockThresholds: Map<NudeNetLabel, Float> = NudeNetGatePolicy.DEFAULT_BLOCK_THRESHOLDS,
    private val candidateScoreThreshold: Float = 0.2f,
    private val nmsIouThreshold: Float = 0.45f,
) : NsfwClassifier {

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val inputName: String
    val executionProvider: ExecutionProvider

    init {
        val modelBytes = context.assets.open(modelAssetPath).use { it.readBytes() }
        val (createdSession, ep) = createSession(modelBytes)
        session = createdSession
        executionProvider = ep
        inputName = session.inputNames.first()

        Log.i(
            TAG,
            "session ready: model=$modelAssetPath executionProvider=$executionProvider " +
                "inputSize=${INPUT_SIZE}x$INPUT_SIZE blockThresholds=$blockThresholds",
        )
    }

    private fun createSession(modelBytes: ByteArray): Pair<OrtSession, ExecutionProvider> {
        OrtSession.SessionOptions().use { xnnpackOptions ->
            try {
                xnnpackOptions.setIntraOpNumThreads(BIG_CORE_THREADS)
                xnnpackOptions.addXnnpack(mapOf("intra_op_num_threads" to BIG_CORE_THREADS.toString()))
                return env.createSession(modelBytes, xnnpackOptions) to ExecutionProvider.XNNPACK
            } catch (e: OrtException) {
                Log.w(TAG, "XNNPACK EP init failed, falling back to CPU EP", e)
            }
        }
        OrtSession.SessionOptions().apply { setIntraOpNumThreads(BIG_CORE_THREADS) }.use { cpuOptions ->
            return env.createSession(modelBytes, cpuOptions) to ExecutionProvider.CPU
        }
    }

    /**
     * Gate 7 entry point for the existing cascade. Returns 1f if any
     * block-listed label's detection score exceeds its configured
     * threshold, else 0f - ContentGuardService's existing
     * `score < prefs.nsfwThreshold` comparison (slider capped at 1.0)
     * always resolves correctly against this either way, same trick
     * SiglipNsfwClassifier already relies on, so the label-set decision
     * made here is authoritative regardless of where that slider sits.
     */
    override fun scoreNsfw(bitmap: Bitmap, packageName: String?): Float {
        val result = detect(bitmap, packageName)
        return if (result.blocked) 1f else 0f
    }

    data class GateResult(
        val blocked: Boolean,
        val detections: List<Detection>,
        val preprocessMs: Long,
        val inferenceMs: Long,
        val decisionMs: Long,
    )

    fun detect(bitmap: Bitmap, packageName: String? = null): GateResult {
        val pkgTag = packageName ?: "?"

        val preprocessStartNanos = System.nanoTime()
        val (inputBuffer, scale) = letterboxAndPreprocess(bitmap)
        val preprocessMs = (System.nanoTime() - preprocessStartNanos) / 1_000_000

        val inferenceStartNanos = System.nanoTime()
        val shape = longArrayOf(1, 3, INPUT_SIZE.toLong(), INPUT_SIZE.toLong())
        val rawOutput = OnnxTensor.createTensor(env, inputBuffer, shape).use { tensor ->
            session.run(mapOf(inputName to tensor)).use { results ->
                @Suppress("UNCHECKED_CAST")
                (results.get(OUTPUT_NAME).get().value as Array<Array<FloatArray>>)[0]
            }
        }
        val inferenceMs = (System.nanoTime() - inferenceStartNanos) / 1_000_000

        val decisionStartNanos = System.nanoTime()
        val detections = parseDetections(rawOutput, scale, bitmap.width, bitmap.height)
        val escalated = maybeRunTiledEscalation(bitmap, packageName, detections)
        val blocked = escalated.any { d -> (blockThresholds[d.label] ?: Float.MAX_VALUE) <= d.score }
        val decisionMs = (System.nanoTime() - decisionStartNanos) / 1_000_000

        val detectionSummary = if (escalated.isEmpty()) {
            "none"
        } else {
            escalated.joinToString(", ") { "${it.label}=${"%.2f".format(it.score)}@${it.box}" }
        }
        val line = "[$pkgTag] regionPx=${bitmap.width}x${bitmap.height} detections=$detectionSummary " +
            "blocked=$blocked ep=$executionProvider " +
            "timing(preprocessMs=$preprocessMs inferenceMs=$inferenceMs decisionMs=$decisionMs)"
        Log.d(TAG, line)
        DebugLogBuffer.add(TAG, line)

        return GateResult(blocked, escalated, preprocessMs, inferenceMs, decisionMs)
    }

    /**
     * Letterbox: pad the analyzed bitmap to a square on the bottom/right
     * only (black fill, no centering), then resize that square to
     * 320x320 - exactly nudenet.py's own `_read_image`/`cv2.copyMakeBorder`
     * + `cv2.dnn.blobFromImage` recipe, so box coordinates decoded back out
     * of the padded-square space land at the same place in the original
     * bitmap's own coordinates with no offset correction needed (padding
     * never moved the origin). Returns the NCHW float32 RGB [0,1] buffer
     * plus the scale factor (paddedSize / 320) needed to project model-
     * space boxes back to the original bitmap.
     */
    private fun letterboxAndPreprocess(bitmap: Bitmap): Pair<FloatBuffer, Float> {
        val paddedSize = max(bitmap.width, bitmap.height)
        val padded = Bitmap.createBitmap(paddedSize, paddedSize, Bitmap.Config.ARGB_8888)
        Canvas(padded).apply {
            drawColor(Color.BLACK)
            drawBitmap(bitmap, 0f, 0f, null)
        }

        val resized = if (paddedSize == INPUT_SIZE) padded else Bitmap.createScaledBitmap(padded, INPUT_SIZE, INPUT_SIZE, true)
        if (resized !== padded) padded.recycle()

        val plane = INPUT_SIZE * INPUT_SIZE
        val pixels = IntArray(plane)
        resized.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE)

        val buffer = FloatBuffer.allocate(3 * plane)
        for (i in 0 until plane) {
            val p = pixels[i]
            buffer.put(i, ((p shr 16) and 0xFF) / 255f)
            buffer.put(plane + i, ((p shr 8) and 0xFF) / 255f)
            buffer.put(2 * plane + i, (p and 0xFF) / 255f)
        }
        resized.recycle()

        return buffer to (paddedSize.toFloat() / INPUT_SIZE)
    }

    /**
     * output0 is [1, 22, 2100]: channels 0-3 are box (cx, cy, w, h) in
     * absolute 320-space pixel coordinates (already grid+stride decoded in
     * the graph), channels 4-21 are per-class confidence (already sigmoid-
     * activated in the graph, confirmed by the model's own output range on
     * a random-noise input during verification). Confirmed NOT NMS'd - the
     * greedy class-agnostic suppression below matches nudenet.py's own
     * `cv2.dnn.NMSBoxes(boxes, scores, 0.25, 0.45)` call (single IoU pass
     * across all classes together, not per-class).
     */
    private fun parseDetections(output: Array<FloatArray>, scale: Float, origWidth: Int, origHeight: Int): List<Detection> {
        val numAnchors = output[0].size
        val candidates = ArrayList<Detection>()

        for (a in 0 until numAnchors) {
            var bestClassId = -1
            var bestScore = 0f
            for (c in NudeNetLabel.entries.indices) {
                val s = output[4 + c][a]
                if (s > bestScore) {
                    bestScore = s
                    bestClassId = c
                }
            }
            if (bestClassId < 0 || bestScore < candidateScoreThreshold) continue

            val cx = output[0][a]
            val cy = output[1][a]
            val w = output[2][a]
            val h = output[3][a]

            val left = ((cx - w / 2f) * scale).coerceIn(0f, origWidth.toFloat())
            val top = ((cy - h / 2f) * scale).coerceIn(0f, origHeight.toFloat())
            val right = ((cx + w / 2f) * scale).coerceIn(left, origWidth.toFloat())
            val bottom = ((cy + h / 2f) * scale).coerceIn(top, origHeight.toFloat())

            candidates.add(
                Detection(
                    label = NudeNetLabel.entries[bestClassId],
                    score = bestScore,
                    box = Rect(left.toInt(), top.toInt(), right.toInt(), bottom.toInt()),
                ),
            )
        }

        return classAgnosticNms(candidates)
    }

    private fun classAgnosticNms(detections: List<Detection>): List<Detection> {
        val sorted = detections.sortedByDescending { it.score }
        val kept = ArrayList<Detection>()
        for (candidate in sorted) {
            val suppressed = kept.any { iou(it.box, candidate.box) > nmsIouThreshold }
            if (!suppressed) kept.add(candidate)
        }
        return kept
    }

    private fun iou(a: Rect, b: Rect): Float {
        val interLeft = max(a.left, b.left)
        val interTop = max(a.top, b.top)
        val interRight = min(a.right, b.right)
        val interBottom = min(a.bottom, b.bottom)
        val interArea = max(0, interRight - interLeft) * max(0, interBottom - interTop)
        val areaA = a.width() * a.height()
        val areaB = b.width() * b.height()
        val union = areaA + areaB - interArea
        return if (union <= 0) 0f else interArea.toFloat() / union
    }

    /**
     * Disabled-by-default hook for the small-object recall gap documented
     * in this class's doc comment (targets under ~64px on-screen are
     * silently missed at 320x320). Deliberately unimplemented: running 2x2
     * tiled 320n passes would ~4x the inference cost of this gate, and per
     * the explicit instruction this migration shipped under, that's not
     * worth doing pre-emptively before the per-frame logging above
     * (region size + detections, searchable by package) shows an actual
     * miss-rate problem in practice. Flip [TILED_ESCALATION_ENABLED] only
     * once tiled inference is actually implemented here.
     */
    private fun maybeRunTiledEscalation(bitmap: Bitmap, packageName: String?, baseline: List<Detection>): List<Detection> {
        if (!TILED_ESCALATION_ENABLED) return baseline
        Log.w(TAG, "TILED_ESCALATION_ENABLED is set but tiled inference is not implemented - ignoring")
        return baseline
    }

    override fun close() {
        session.close()
    }

    companion object {
        private const val TAG = "NudeNetDetector"
        const val ASSET_NAME = "320n.onnx"
        private const val INPUT_SIZE = 320
        private const val OUTPUT_NAME = "output0"

        // "2 big cores" per the migration spec - sporadic single-frame
        // inference doesn't benefit from spreading across every core, and
        // over-subscribing little cores on a big.LITTLE SoC just adds
        // scheduling noise.
        private const val BIG_CORE_THREADS = 2

        // See [maybeRunTiledEscalation] - do not flip without implementing it first.
        const val TILED_ESCALATION_ENABLED = false
    }
}
