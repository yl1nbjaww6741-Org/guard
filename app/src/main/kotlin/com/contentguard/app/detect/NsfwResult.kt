package com.contentguard.app.detect

/** Which backend actually served the last inference - for on-device EP verification. */
enum class ExecutionProvider { NNAPI, CPU }

/**
 * Rich result for direct callers (as opposed to [NsfwClassifier.scoreNsfw], which
 * only returns the bare score for the existing cascade in ContentGuardService).
 */
data class NsfwResult(
    val sfwProb: Float,
    val nsfwProb: Float,
    val isNsfw: Boolean,
    val executionProvider: ExecutionProvider,
    val inferenceTimeMs: Long,
)
