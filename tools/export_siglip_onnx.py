#!/usr/bin/env python3
"""PART 1: Export prithivMLmods/siglip2-mini-explicit-content to ONNX and
apply dynamic (weight-only) quantization - no calibration dataset needed,
since QuantType.QUInt8 dynamic quantization computes activation ranges at
runtime rather than from calibration data.

Not runnable in the sandbox this repo was scaffolded in - huggingface.co
is blocked at the network-policy level there (confirmed repeatedly this
session). Run this on your own machine with a real internet connection.

Usage:
    pip install torch transformers onnx onnxruntime pillow numpy

    python tools/export_siglip_onnx.py \
        --output-dir ./siglip_export \
        --sample-images /path/to/a/few/sfw/test/images

Produces:
    <output-dir>/siglip2_mini_explicit.onnx             (unquantized fp32)
    <output-dir>/siglip2_mini_explicit_quantized.onnx   (dynamic QUInt8)

And prints, in order:
    1. The model's *actual* input size / image_mean / image_std, read off
       its own AutoImageProcessor config - do NOT assume 512x512 just
       because the base checkpoint is named "patch16-512"; a fine-tune's
       processor config can override that. This script reads whatever the
       processor actually reports and uses that for the dummy export
       input, rather than hardcoding a guess.
    2. File sizes of both ONNX files.
    3. If --sample-images is given: PyTorch (fp32) vs. quantized-ONNX
       predictions on each sample image, so you can see the label mapping
       and catch any quantization-induced accuracy drift before this goes
       anywhere near the Android app. Strongly recommended - pass a
       folder with a few of your own ordinary/SFW photos, nothing
       sensitive needed for this check.

If torch.onnx.export fails on an unsupported op, it will raise and this
script will stop there - no silent workarounds. Report the failing op
back rather than trying to patch around it.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image
from transformers import AutoImageProcessor, SiglipForImageClassification

MODEL_ID = "prithivMLmods/siglip2-mini-explicit-content"


class LogitsOnlyWrapper(torch.nn.Module):
    """SiglipForImageClassification.forward() returns a ModelOutput
    dataclass, not a plain tensor - torch.onnx.export needs a traceable
    tensor output, so wrap the model to return just .logits."""

    def __init__(self, model: SiglipForImageClassification):
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        return self.model(pixel_values=pixel_values).logits


def load_model_and_processor() -> tuple[SiglipForImageClassification, AutoImageProcessor]:
    print(f"Loading {MODEL_ID} ...")
    model = SiglipForImageClassification.from_pretrained(MODEL_ID)
    processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model.eval()
    return model, processor


def describe_processor(processor: AutoImageProcessor) -> tuple[int, int]:
    size = getattr(processor, "size", None)
    if not isinstance(size, dict):
        raise SystemExit(f"Unexpected processor.size format: {size!r} - inspect processor manually")

    height = size.get("height") or size.get("shortest_edge")
    width = size.get("width") or size.get("shortest_edge")
    if not height or not width:
        raise SystemExit(f"Could not determine height/width from processor.size={size!r}")

    mean = getattr(processor, "image_mean", None)
    std = getattr(processor, "image_std", None)

    print(f"Confirmed input size: {height}x{width}")
    print(f"Confirmed image_mean: {mean}")
    print(f"Confirmed image_std:  {std}")
    if (height, width) != (512, 512):
        print("NOTE: this is NOT 512x512 - do not hardcode 512 anywhere downstream (Android preprocessor included).")

    return int(height), int(width)


def export_onnx(model: SiglipForImageClassification, height: int, width: int, output_path: Path) -> None:
    wrapped = LogitsOnlyWrapper(model)
    dummy_input = torch.randn(1, 3, height, width, dtype=torch.float32)

    print(f"Exporting to ONNX (opset 17) -> {output_path}")
    torch.onnx.export(
        wrapped,
        dummy_input,
        str(output_path),
        input_names=["pixel_values"],
        output_names=["logits"],
        dynamic_axes={"pixel_values": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )


def quantize_dynamic(input_path: Path, output_path: Path) -> None:
    from onnxruntime.quantization import QuantType
    from onnxruntime.quantization import quantize_dynamic as ort_quantize_dynamic

    print(f"Applying dynamic quantization (QUInt8, no calibration data) -> {output_path}")
    ort_quantize_dynamic(
        model_input=str(input_path),
        model_output=str(output_path),
        weight_type=QuantType.QUInt8,
    )


def report_sizes(fp32_path: Path, quantized_path: Path) -> None:
    fp32_size = fp32_path.stat().st_size
    quant_size = quantized_path.stat().st_size
    print(f"\n{fp32_path.name}: {fp32_size:,} bytes")
    print(f"{quantized_path.name}: {quant_size:,} bytes ({quant_size / fp32_size:.1%} of fp32)")


def sanity_check(
    model: SiglipForImageClassification,
    processor: AutoImageProcessor,
    quantized_path: Path,
    sample_images_dir: Path,
    id2label: dict,
) -> None:
    paths = sorted(
        p for p in sample_images_dir.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")
    )[:3]
    if not paths:
        print(f"\nNo .jpg/.jpeg/.png files found in {sample_images_dir} - skipping sanity check.")
        return

    session = ort.InferenceSession(str(quantized_path))
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    print(f"\nQuantized ONNX output shape: {session.get_outputs()[0].shape}")

    for path in paths:
        image = Image.open(path).convert("RGB")
        pixel_values = processor(images=image, return_tensors="np")["pixel_values"].astype(np.float32)

        with torch.no_grad():
            torch_logits = model(pixel_values=torch.from_numpy(pixel_values)).logits.numpy()[0]
        onnx_logits = session.run([output_name], {input_name: pixel_values})[0][0]

        torch_label = id2label[int(np.argmax(torch_logits))]
        onnx_label = id2label[int(np.argmax(onnx_logits))]
        flag = "" if torch_label == onnx_label else "  <-- DISCREPANCY: quantization changed the predicted label"

        print(f"\n{path.name}:")
        print(f"  PyTorch (fp32):   {torch_label}  logits={np.round(torch_logits, 3).tolist()}")
        print(f"  ONNX (quantized): {onnx_label}  logits={np.round(onnx_logits, 3).tolist()}{flag}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-dir", type=Path, default=Path("./siglip_export"))
    parser.add_argument(
        "--sample-images",
        type=Path,
        default=None,
        help="Folder of a few ordinary/SFW test images for the PyTorch-vs-ONNX sanity check (recommended)",
    )
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    fp32_path = args.output_dir / "siglip2_mini_explicit.onnx"
    quantized_path = args.output_dir / "siglip2_mini_explicit_quantized.onnx"

    model, processor = load_model_and_processor()
    height, width = describe_processor(processor)

    id2label = model.config.id2label
    print(f"id2label: {id2label}")

    export_onnx(model, height, width, fp32_path)
    quantize_dynamic(fp32_path, quantized_path)
    report_sizes(fp32_path, quantized_path)

    if args.sample_images:
        sanity_check(model, processor, quantized_path, args.sample_images, id2label)
    else:
        print(
            "\nNo --sample-images given - skipping the PyTorch-vs-ONNX sanity check. "
            "Strongly recommended before this touches Android at all."
        )


if __name__ == "__main__":
    main()
