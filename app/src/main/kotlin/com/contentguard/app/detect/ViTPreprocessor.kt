package com.contentguard.app.detect

import android.graphics.Bitmap
import java.nio.FloatBuffer

/**
 * Preprocessing for AdamCodd/vit-base-nsfw-detector (ViTForImageClassification,
 * patch16-384). Values below are read off the model's own
 * preprocessor_config.json / config.json, not guessed:
 *
 *  - size: 384x384 (config.json "image_size": 384)
 *  - image_mean / image_std: [0.5, 0.5, 0.5] each (ViTImageProcessor default),
 *    i.e. pixel/255 is rescaled into [-1, 1] rather than [0, 1]
 *  - layout: NCHW float32, input tensor name "pixel_values" (confirmed by
 *    inspecting the onnx/model_fp16.onnx graph directly - elem_type FLOAT,
 *    dims [batch, channels, height, width])
 *
 * Also reused as-is by SiglipNsfwClassifier: prithivMLmods/siglip2-mini-explicit-content
 * happens to use the identical [0.5, 0.5, 0.5] mean/std convention, just a
 * different (also confirmed, not assumed) square size - toNchwBuffer's
 * inputSize parameter already supports that without changes here.
 *
 * If you swap in a different model later, update INPUT_SIZE/MEAN/STD (and
 * the relevant classifier's input/output tensor names) to match its own
 * config - nothing here is ViT-specific beyond these constants.
 */
object ViTPreprocessor {

    const val INPUT_SIZE = 384
    private val MEAN = floatArrayOf(0.5f, 0.5f, 0.5f)
    private val STD = floatArrayOf(0.5f, 0.5f, 0.5f)

    /** NCHW float32 buffer of shape [1, 3, INPUT_SIZE, INPUT_SIZE], normalized to [-1, 1]. */
    fun toNchwBuffer(bitmap: Bitmap, inputSize: Int = INPUT_SIZE): FloatBuffer {
        val resized = if (bitmap.width == inputSize && bitmap.height == inputSize) {
            bitmap
        } else {
            Bitmap.createScaledBitmap(bitmap, inputSize, inputSize, true)
        }

        val plane = inputSize * inputSize
        val pixels = IntArray(plane)
        resized.getPixels(pixels, 0, inputSize, 0, 0, inputSize, inputSize)

        val buffer = FloatBuffer.allocate(3 * plane)
        for (i in 0 until plane) {
            val pixel = pixels[i]
            buffer.put(i, (((pixel shr 16) and 0xFF) / 255f - MEAN[0]) / STD[0])
            buffer.put(plane + i, (((pixel shr 8) and 0xFF) / 255f - MEAN[1]) / STD[1])
            buffer.put(2 * plane + i, ((pixel and 0xFF) / 255f - MEAN[2]) / STD[2])
        }

        if (resized !== bitmap) resized.recycle()
        return buffer
    }
}
