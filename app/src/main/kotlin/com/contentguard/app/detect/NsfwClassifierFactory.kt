package com.contentguard.app.detect

import android.content.Context
import android.util.Log
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.util.DebugLogBuffer
import java.io.IOException

object NsfwClassifierFactory {

    const val NUDENET_MODEL_ASSET = NudeNetDetector.ASSET_NAME
    const val ONNX_MODEL_ASSET = "nsfw.onnx"
    private const val TAG = "NsfwClassifierFactory"

    // Opt-in per NudeNetGatePolicy's doc comment - accepts the known
    // gender-misclassification tradeoff (shirtless men sometimes tagged
    // FEMALE_BREAST_EXPOSED) in exchange for catching real female breast
    // exposure instead of ignoring it entirely.
    private const val BLOCK_FEMALE_BREAST_EXPOSED = true

    // Off by default - sport/gym content makes this the riskier of the two
    // to enable (a correctly-labeled shirtless man is the common case this
    // was built to avoid blocking on). Flip it if that false-positive rate
    // turns out to be acceptable for your own usage.
    private const val BLOCK_MALE_BREAST_EXPOSED = false

    /**
     * Prefers assets/320n.onnx (NudeNetDetector - label-set body-part
     * detection gate, see its class doc for why this replaced the old
     * whole-image SigLIP2 classifier), then falls back to the legacy
     * assets/nsfw.onnx (OnnxNsfwClassifier) if only that is present, so
     * swapping the model file is the only thing needed to change backends
     * - no caller-side changes. The TFLite backend that used to sit third in
     * this chain is gone: it was an unimplemented skeleton for an asset that
     * was never committed, so it could not activate in any shipped build
     * while still packaging libtensorflowlite_jni.so into every APK.
     */
    fun create(context: Context): NsfwClassifier {
        // Per-inference diagnostic logging in the classifier backends is
        // gated behind this, exactly like ContentGuardService.exitSafe gates
        // the routine gate-exit logs: a running classifier scores a frame
        // every couple of seconds while any monitored app is foreground, and
        // paying a string build + Log.d + DebugLogBuffer write (SimpleDateFormat
        // + a synchronized deque insert) on every one of those, whether or not
        // anyone is watching the Debug log, is the kind of unconditional
        // hot-path work the rest of this app deliberately avoids. Read through
        // a live provider (not a captured boolean) so toggling verbose logging
        // in Settings takes effect without recreating the classifier. Blocks
        // themselves are still logged unconditionally at the service layer
        // (GATE8_BLOCK), so nothing meaningful is lost when this is off.
        val prefs = PrefsRepository(context)
        val verboseLogging: () -> Boolean = { prefs.verboseLogging }

        // Every backend below catches Throwable, not Exception. Loading any
        // of these is the one place in the app that pulls in a native runtime
        // (ONNX Runtime), and a native load failure surfaces as
        // UnsatisfiedLinkError or ExceptionInInitializerError - Errors, not
        // Exceptions. Catching only Exception meant such a failure propagated
        // straight out of create() and aborted ContentGuardService's whole
        // setup, rather than degrading to the next backend as intended.
        if (assetExists(context, NUDENET_MODEL_ASSET)) {
            try {
                var blockThresholds = NudeNetGatePolicy.DEFAULT_BLOCK_THRESHOLDS
                if (BLOCK_FEMALE_BREAST_EXPOSED) {
                    blockThresholds = blockThresholds + NudeNetGatePolicy.FEMALE_BREAST_EXPOSED_THRESHOLD
                }
                if (BLOCK_MALE_BREAST_EXPOSED) {
                    blockThresholds = blockThresholds + NudeNetGatePolicy.MALE_BREAST_EXPOSED_THRESHOLD
                }
                return NudeNetDetector(context, NUDENET_MODEL_ASSET, blockThresholds, verboseLogging = verboseLogging)
            } catch (t: Throwable) {
                logLoadFailure(NUDENET_MODEL_ASSET, t)
            }
        }

        if (assetExists(context, ONNX_MODEL_ASSET)) {
            try {
                return OnnxNsfwClassifier(context, ONNX_MODEL_ASSET, verboseLogging = verboseLogging)
            } catch (t: Throwable) {
                logLoadFailure(ONNX_MODEL_ASSET, t)
            }
        }

        // Unconditional, and mirrored into DebugLogBuffer rather than left as
        // a logcat-only line: this is the single most consequential state the
        // app can be in - gate 7 scores every frame 0f, so no amount of
        // explicit content will ever be blocked - and it is otherwise
        // completely silent from inside the app. Anyone looking at the
        // Activity tab's Debug log because "it isn't blocking anything" needs
        // to see this first, not have to reach for adb logcat.
        val line = "NO_CLASSIFIER - using StubNsfwClassifier: gate 7 always scores 0, nothing will ever be blocked"
        Log.w(TAG, line)
        DebugLogBuffer.add(TAG, line)
        return StubNsfwClassifier()
    }

    private fun logLoadFailure(asset: String, t: Throwable) {
        val line = "CLASSIFIER_LOAD_FAILED asset=$asset ${t.javaClass.simpleName}: ${t.message}"
        Log.e(TAG, line, t)
        DebugLogBuffer.add(TAG, line)
    }

    private fun assetExists(context: Context, path: String): Boolean = try {
        context.assets.open(path).close()
        true
    } catch (e: IOException) {
        false
    }
}
