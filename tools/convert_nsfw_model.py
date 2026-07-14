#!/usr/bin/env python3
"""Convert GantMan/nsfw_model's MobileNetV2 Keras model to nsfw.tflite for
ContentGuard, at whichever quantization level you want.

Not runnable in the sandbox this repo was scaffolded in - it needs a real
internet connection (to fetch the model, if you don't already have it) and
a Python + TensorFlow environment. Run it on your own machine.

Usage:
    pip install tensorflow pillow numpy

    # Default: plain float32, no quantization. Simplest - no
    # representative images needed. Larger/slower model; fine for
    # proving the pipeline works before optimizing.
    python tools/convert_nsfw_model.py \
        --model /path/to/mobilenet_v2_140_224 \
        --output app/src/main/assets/nsfw.tflite

    # Dynamic-range quantization: weights only, int8; activations stay
    # float32. Still no representative images needed. Smaller file, some
    # speed benefit, minimal effort over the float32 default.
    python tools/convert_nsfw_model.py \
        --model /path/to/mobilenet_v2_140_224 \
        --quantize dynamic \
        --output app/src/main/assets/nsfw.tflite

    # Full integer (INT8) quantization: smallest and fastest, but needs a
    # representative-images folder for calibration.
    python tools/convert_nsfw_model.py \
        --model /path/to/mobilenet_v2_140_224 \
        --quantize int8 \
        --representative-images /path/to/sample_images_dir \
        --output app/src/main/assets/nsfw.tflite

Where to get --model:
    https://github.com/GantMan/nsfw_model (MIT licensed) - grab the
    MobileNetV2 variant from their Releases page. It may come as a Keras
    .h5 file or a TF SavedModel directory; both are handled below.

What --representative-images should be (int8 only):
    A folder of ~100-500 sample JPEG/PNG images, roughly matching what the
    real cascade will actually feed the classifier: downscaled screenshot
    crops (see capture/ScreenCapturer.kt - ~640px longest edge before this
    script's own resize to 224x224) covering a realistic mix of SFW and
    NSFW content. This is what calibrates the INT8 quantization scale/
    zero-point - an unrepresentative sample here produces a technically
    valid but inaccurate model, not an error you'll see at conversion time.

Preprocessing note: GantMan's own predict.py does a plain `image /= 255`
(0..1 float), NOT the standard Keras MobileNetV2 preprocess_input's
[-1, 1] scaling - this script replicates that exact preprocessing so the
int8 calibration (and the float32/dynamic paths, which need no
calibration but still expect the same input convention) matches what the
model was actually trained/evaluated with. Kotlin-side,
TFLiteNsfwClassifier's NormalizeOp(0f, 255f) does the same /255 scaling
for float32 inputs and needs no changes for any of the three modes below -
it reads input/output dtype off the model itself. The class taxonomy
(5-way softmax: drawings/hentai/neutral/porn/sexy) is also handled
already via TFLiteNsfwClassifier's unsafeClassIndices, regardless of
quantization mode.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import tensorflow as tf
from PIL import Image

IMAGE_SIZE = 224


def make_representative_dataset(images_dir: Path, max_images: int = 300):
    paths = sorted(
        p for p in images_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")
    )[:max_images]
    if not paths:
        raise SystemExit(f"No .jpg/.jpeg/.png files found in {images_dir}")

    def representative_dataset():
        for path in paths:
            image = Image.open(path).convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE))
            array = np.asarray(image, dtype=np.float32) / 255.0
            yield [np.expand_dims(array, axis=0)]

    return representative_dataset


def convert(model_path: Path, quantize: str, images_dir: Path | None, output_path: Path) -> None:
    # tf.keras.models.load_model handles both a .h5 file and a Keras-saved
    # SavedModel directory transparently.
    model = tf.keras.models.load_model(str(model_path))
    converter = tf.lite.TFLiteConverter.from_keras_model(model)

    if quantize == "int8":
        if images_dir is None:
            raise SystemExit("--quantize int8 requires --representative-images")
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.representative_dataset = make_representative_dataset(images_dir)
        converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
        converter.inference_input_type = tf.uint8
        converter.inference_output_type = tf.uint8
    elif quantize == "dynamic":
        # Weights only, quantized to int8; activations computed in
        # float32 at runtime. No representative dataset needed.
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
    # "none": no optimizations set at all - plain float32 model.

    tflite_model = converter.convert()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(tflite_model)
    print(f"Wrote {output_path} ({len(tflite_model):,} bytes, quantize={quantize})")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model", required=True, type=Path, help="Path to .h5 file or SavedModel dir")
    parser.add_argument(
        "--quantize",
        choices=["none", "dynamic", "int8"],
        default="none",
        help="none (default, float32) / dynamic (weights-only int8) / int8 (full integer, needs --representative-images)",
    )
    parser.add_argument("--representative-images", type=Path, default=None)
    parser.add_argument("--output", default=Path("app/src/main/assets/nsfw.tflite"), type=Path)
    args = parser.parse_args()

    convert(args.model, args.quantize, args.representative_images, args.output)


if __name__ == "__main__":
    main()
