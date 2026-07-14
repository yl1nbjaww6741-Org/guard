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
 * dtype off the model itself rather than hardcoding them, so it adapts to
 * whatever nsfw.tflite you actually drop in - a single sigmoid output,
 * float32 or fully-integer-quantized (uint8/int8 with scale+zero-point),
 * is all it assumes.
 *
 * Input size is whatever the model reports (target 128-160px per the
 * design doc); resizing/normalizing happens in [imageProcessor] based on
 * that shape, not a hardcoded constant.
 */
class TFLiteNsfwClassifier(context: Context, modelAssetPath: String) : NsfwClassifier {

    private val interpreter: Interpreter
    private val inputDataType: DataType
    private val outputDataType: DataType
    private val outputShape: IntArray
    private val imageProcessor: ImageProcessor

    init {
        val options = Interpreter.Options().apply {
            setNumThreads(2)
            // CPU + XNNPACK, not NNAPI/GPU: inference here is rare and
            // bursty by design (that's the entire point of the cascade),
            // so an accelerator's setup/wake cost usually exceeds what
            // it'd save on a single 128-160px INT8 forward pass. Swap this
            // for an NNAPI/GPU delegate only if on-device profiling shows
            // CPU inference itself - not delegate switching overhead - is
            // the bottleneck.
            setUseXNNPACK(true)
        }
        interpreter = Interpreter(loadModelFile(context, modelAssetPath), options)

        val inputTensor = interpreter.getInputTensor(0)
        val outputTensor = interpreter.getOutputTensor(0)
        inputDataType = inputTensor.dataType()
        outputDataType = outputTensor.dataType()
        outputShape = outputTensor.shape()

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

    override fun scoreNsfw(bitmap: Bitmap): Float {
        var tensorImage = TensorImage(inputDataType)
        tensorImage.load(bitmap)
        tensorImage = imageProcessor.process(tensorImage)

        val score = when (outputDataType) {
            DataType.FLOAT32 -> {
                val output = Array(1) { FloatArray(outputShape.last()) }
                interpreter.run(tensorImage.buffer, output)
                output[0][0]
            }
            else -> {
                // UINT8/INT8 fully-integer-quantized output (assumes a
                // single-element output tensor, i.e. one sigmoid score).
                // Read the raw byte ourselves and dequantize with the
                // tensor's own scale/zero-point.
                val outputBytes = ByteBuffer.allocateDirect(1).order(ByteOrder.nativeOrder())
                interpreter.run(tensorImage.buffer, outputBytes)
                outputBytes.rewind()
                val raw = if (outputDataType == DataType.INT8) {
                    outputBytes.get().toInt()
                } else {
                    outputBytes.get().toInt() and 0xFF
                }
                val quant = interpreter.getOutputTensor(0).quantizationParams()
                (raw - quant.zeroPoint) * quant.scale
            }
        }
        return score.coerceIn(0f, 1f)
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
}
