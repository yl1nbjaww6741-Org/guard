package com.contentguard.app.detect

import android.content.Context
import android.graphics.Bitmap
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.support.common.ops.NormalizeOp
import org.tensorflow.lite.support.image.ImageProcessor
import org.tensorflow.lite.support.image.TensorImage
import org.tensorflow.lite.support.image.ops.ResizeOp
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel

/**
 * Skeleton only - no model is bundled (see NsfwClassifierFactory). This
 * class exists so swapping in a real assets/nsfw.tflite later touches only
 * this file, per the acceptance criteria. It reads input/output shape and
 * dtype off the model itself, so it adapts to whatever nsfw.tflite you
 * actually drop in rather than hardcoding a contract:
 *
 *  - Input: any HxW (target 128-160px per the design doc, though a larger
 *    input like a 224px MobileNetV2 works too - it just costs a bit more
 *    CPU per inference, which is fine since gate 7 runs rarely by design).
 *    Float32 (normalized) or fully-integer-quantized (uint8/int8).
 *
 *  - Output: either a single sigmoid NSFW-probability value, or a
 *    multi-class softmax (e.g. GantMan/nsfw_model's 5-class
 *    drawings/hentai/neutral/porn/sexy taxonomy - see
 *    https://github.com/GantMan/nsfw_model, MIT licensed). For multi-class
 *    output, [unsafeClassIndices] says which classes count as "unsafe";
 *    their probabilities are summed into the single score the rest of the
 *    cascade compares against nsfwThreshold. Default indices assume
 *    GantMan's fixed alphabetical class order (hentai=1, porn=3, sexy=4) -
 *    change the constructor argument if you convert a model with a
 *    different class order or you want to exclude "sexy" (suggestive but
 *    non-explicit, e.g. swimwear/underwear) from what counts as unsafe.
 */
class TFLiteNsfwClassifier(
    context: Context,
    modelAssetPath: String,
    private val unsafeClassIndices: Set<Int> = DEFAULT_UNSAFE_CLASS_INDICES,
) : NsfwClassifier {

    private val interpreter: Interpreter
    private val inputDataType: DataType
    private val outputDataType: DataType
    private val outputSize: Int
    private val imageProcessor: ImageProcessor

    init {
        val options = Interpreter.Options().apply {
            setNumThreads(2)
            // CPU + XNNPACK, not NNAPI/GPU: inference here is rare and
            // bursty by design (that's the entire point of the cascade),
            // so an accelerator's setup/wake cost usually exceeds what
            // it'd save on a single forward pass. Swap this for an
            // NNAPI/GPU delegate only if on-device profiling shows CPU
            // inference itself - not delegate switching overhead - is
            // the bottleneck.
            setUseXNNPACK(true)
        }
        interpreter = Interpreter(loadModelFile(context, modelAssetPath), options)

        val inputTensor = interpreter.getInputTensor(0)
        val outputTensor = interpreter.getOutputTensor(0)
        inputDataType = inputTensor.dataType()
        outputDataType = outputTensor.dataType()
        outputSize = outputTensor.shape().last()

        val inputShape = inputTensor.shape() // [1, height, width, channels]
        val height = inputShape[1]
        val width = inputShape[2]

        val processorBuilder = ImageProcessor.Builder()
            .add(ResizeOp(height, width, ResizeOp.ResizeMethod.BILINEAR))
        if (inputDataType == DataType.FLOAT32) {
            // Quantized (UINT8/INT8) inputs are fed raw 0-255 values - the
            // model's own quantization params encode the normalization
            // that was baked in at conversion time. Float models expect
            // normalized input instead.
            processorBuilder.add(NormalizeOp(0f, 255f))
        }
        imageProcessor = processorBuilder.build()
    }

    override fun scoreNsfw(bitmap: Bitmap, packageName: String?): Float {
        var tensorImage = TensorImage(inputDataType)
        tensorImage.load(bitmap)
        tensorImage = imageProcessor.process(tensorImage)

        val probs = readOutputProbs(tensorImage)
        val score = if (probs.size == 1) {
            probs[0]
        } else {
            unsafeClassIndices.filter { it < probs.size }.sumOf { probs[it].toDouble() }.toFloat()
        }
        return score.coerceIn(0f, 1f)
    }

    private fun readOutputProbs(tensorImage: TensorImage): FloatArray {
        return when (outputDataType) {
            DataType.FLOAT32 -> {
                val output = Array(1) { FloatArray(outputSize) }
                interpreter.run(tensorImage.buffer, output)
                output[0]
            }
            else -> {
                // UINT8/INT8 fully-integer-quantized output. Read the raw
                // bytes ourselves and dequantize each with the tensor's
                // own scale/zero-point.
                val outputBytes = ByteBuffer.allocateDirect(outputSize).order(ByteOrder.nativeOrder())
                interpreter.run(tensorImage.buffer, outputBytes)
                outputBytes.rewind()
                val quant = interpreter.getOutputTensor(0).quantizationParams()
                FloatArray(outputSize) {
                    val raw = if (outputDataType == DataType.INT8) {
                        outputBytes.get().toInt()
                    } else {
                        outputBytes.get().toInt() and 0xFF
                    }
                    (raw - quant.zeroPoint) * quant.scale
                }
            }
        }
    }

    override fun close() {
        interpreter.close()
    }

    private fun loadModelFile(context: Context, assetPath: String): MappedByteBuffer {
        context.assets.openFd(assetPath).use { afd ->
            FileInputStream(afd.fileDescriptor).use { input ->
                return input.channel.map(FileChannel.MapMode.READ_ONLY, afd.startOffset, afd.declaredLength)
            }
        }
    }

    companion object {
        val DEFAULT_UNSAFE_CLASS_INDICES = setOf(1, 3, 4)
    }
}
