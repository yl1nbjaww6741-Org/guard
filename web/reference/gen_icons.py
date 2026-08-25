#!/usr/bin/env python3
"""Generates the PWA icon set for panel.lukep009.download (the existing
dashboard.ts-rendered panel, not ContentGuard Central) - a simple shield
mark matching the Wise-light tokens already established in web/src/lib/
tokens.ts (bright #9FE870 background, forest #163300 glyph), same combo
Drawer.tsx already uses for its own logo mark. Run once, output written
straight to web/dist/icons/ - the actual serving location (worker/
wrangler.toml's [assets] binding), not an intermediate copy - and
committed from there, same "nothing computed live at deploy time,
hand-kept and re-run by hand" pattern web/dist/'s own comment already
establishes.
"""
import math
from PIL import Image, ImageDraw

BRIGHT = (159, 232, 112, 255)  # #9FE870
FOREST = (22, 51, 0, 255)      # #163300


def shield_polygon(cx, cy, w, h):
    # Classic shield silhouette: a shallow V-notch at top-center (the
    # detail that reads as "shield" rather than "house/pin"), tapering
    # sides, single point at the bottom.
    top = cy - h / 2
    bottom = cy + h / 2
    left = cx - w / 2
    right = cx + w / 2
    mid_y = cy + h * 0.05
    notch = h * 0.10
    return [
        (left, top),
        (cx - w * 0.06, top),
        (cx, top + notch),
        (cx + w * 0.06, top),
        (right, top),
        (right, top + h * 0.42),
        (cx + w * 0.20, mid_y + h * 0.18),
        (cx, bottom),
        (cx - w * 0.20, mid_y + h * 0.18),
        (left, top + h * 0.42),
    ]


def make_icon(size, out_path, *, maskable=False, corner_radius_frac=0.0):
    img = Image.new("RGBA", (size, size), BRIGHT if not maskable else BRIGHT)
    draw = ImageDraw.Draw(img)

    if corner_radius_frac > 0:
        # Non-maskable icons get a rounded-square mask (Android ignores
        # this and applies its own shape anyway when maskable=True, but
        # non-maskable/apple-touch-icon contexts render this exactly).
        mask = Image.new("L", (size, size), 0)
        mdraw = ImageDraw.Draw(mask)
        r = int(size * corner_radius_frac)
        mdraw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
        bg = Image.new("RGBA", (size, size), BRIGHT)
        img = Image.composite(bg, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask)
        draw = ImageDraw.Draw(img)

    # Maskable icons need the important content inside Android's safe
    # zone (~66% diameter centered circle) - shrink the shield further
    # and lean on the full-bleed background color for the rest.
    scale = 0.46 if maskable else 0.58
    w = size * scale
    h = size * scale * 1.12
    cx, cy = size / 2, size / 2
    draw.polygon(shield_polygon(cx, cy, w, h), fill=FOREST)

    img.save(out_path)
    print(f"wrote {out_path} ({size}x{size}{', maskable' if maskable else ''})")


if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(__file__), "..", "dist", "icons")
    os.makedirs(out_dir, exist_ok=True)
    make_icon(192, os.path.join(out_dir, "icon-192.png"))
    make_icon(512, os.path.join(out_dir, "icon-512.png"))
    make_icon(512, os.path.join(out_dir, "icon-maskable-512.png"), maskable=True)
    make_icon(180, os.path.join(out_dir, "apple-touch-icon.png"), corner_radius_frac=0.18)
