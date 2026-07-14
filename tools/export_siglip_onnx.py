#!/usr/bin/env python3
"""PART 1: Export prithivMLmods/siglip2-mini-explicit-content to ONNX and
apply dynamic (weight-only) quantization - no calibration images needed,
since QuantType.QUInt8 dynamic quantization computes activation ranges at
runtime rather than from calibration data.

Not runnable in the sandbox this repo was scaffolded in - huggingface.co
is blocked at the network-policy level there (confirmed repeatedly this
session). Run this on your own machine with a real internet connection.

Usage:
    pip install torch transformers onnx onnxruntime

    python tools/export_siglip_onnx.py

Produces, in the current directory:
    siglip2_mini_explicit.onnx       (unquantized fp32)
    siglip2_mini_explicit_int8.onnx  (dynamic QUInt8)

The only thing this doesn't take on faith: input resolution. The model is
fine-tuned from siglip2-base-patch16-512, but a fine-tune's processor
config can override that - so this reads size/mean/std off the model's
own AutoImageProcessor rather than hardcoding 512x512, and prints what it
found before exporting.
"""

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoImageProcessor, SiglipForImageClassification

MODEL_NAME = "prithivMLmods/siglip2-mini-explicit-content"


class LogitsOnlyWrapper(torch.nn.Module):
    """SiglipForImageClassification.forward() returns a ModelOutput
    dataclass, not a plain tensor - torch.onnx.export needs a traceable
    tensor output, so wrap the model to return just .logits."""

    def __init__(self, model: SiglipForImageClassification):
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        return self.model(pixel_values=pixel_values).logits


def confirm_input_size(processor) -> tuple[int, int]:
    size = processor.size
    height = size.get("height") or size.get("shortest_edge")
    width = size.get("width") or size.get("shortest_edge")
    print(f"Confirmed input size: {height}x{width} (not assumed)")
    print(f"Confirmed image_mean: {processor.image_mean}")
    print(f"Confirmed image_std:  {processor.image_std}")
    return int(height), int(width)


# Step 0: load model + processor, confirm real input size
model = SiglipForImageClassification.from_pretrained(MODEL_NAME)
processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
model.eval()
print(f"id2label: {model.config.id2label}")

height, width = confirm_input_size(processor)

# Step 1: export to ONNX
dummy_input = torch.randn(1, 3, height, width)

torch.onnx.export(
    LogitsOnlyWrapper(model),
    dummy_input,
    "siglip2_mini_explicit.onnx",
    input_names=["pixel_values"],
    output_names=["logits"],
    dynamic_axes={"pixel_values": {0: "batch_size"}, "logits": {0: "batch_size"}},
    opset_version=17,
)

# Step 2: quantize - no images needed
quantize_dynamic(
    model_input="siglip2_mini_explicit.onnx",
    model_output="siglip2_mini_explicit_int8.onnx",
    weight_type=QuantType.QUInt8,
)

print("Done: siglip2_mini_explicit.onnx, siglip2_mini_explicit_int8.onnx")
