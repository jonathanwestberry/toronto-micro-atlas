#!/usr/bin/env python3
"""Render exact-count dot rasters of the street tree inventory.

Every tree in data/processed/trees-tiling.ndjson is splatted as a small
gaussian dot into a Web Mercator image, accumulated in linear light and
tone-mapped, so citywide map views show one dot per tree (no decimation)
while dense plantings bloom brighter. MapLibre displays these as image
sources below z14; vector tiles take over above.

Outputs (public/data/fg02/r/), all lossy WebP with alpha:
  base.webp           all trees, category colors
  base-lo.webp        2048px quick-load variant for first paint
  cat-<key>.webp      one per category
  maples-norway.webp  Norway maple bright over dimmed other maples
  maples-sugar.webp   sugar maple hot-white over dimmed other maples
  render.json         image corner coordinates for the map script

Everything renders at 4096px wide: an image source is a full GPU texture
(4096x3160 RGBA = 51 MB); 8192 would cost 207 MB and sink older phones.
Vector tiles take over at z13 where 4096px starts to soften.
"""

import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NDJSON = os.path.join(ROOT, "processed", "trees-tiling.ndjson")
META = os.path.join(os.path.dirname(ROOT), "public", "data", "fg02", "meta.json")
OUT = os.path.join(os.path.dirname(ROOT), "public", "data", "fg02", "r")

# City extent plus margin so edge dots never clip (matches map maxBounds).
WEST, SOUTH, EAST, NORTH = -79.6593, 43.5610, -79.0953, 43.8755

BASE_W = 4096
CAT_W = 4096

# Tone-map strength: how fast accumulated energy saturates. Applied to the
# energy (alpha) channel only; colour is the average of contributing trees,
# so a dense maple street stays ember instead of blowing out to white.
K = 1.2
# Faint white bloom for extreme density (downtown rows), enough to sparkle,
# not enough to erase the hue.
BLOOM_START = 2.5
BLOOM_STRENGTH = 0.18


def merc_y(lat: np.ndarray) -> np.ndarray:
    rad = np.radians(lat)
    return np.log(np.tan(np.pi / 4 + rad / 2))


def hex_to_linear(h: str) -> np.ndarray:
    h = h.lstrip("#")
    srgb = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0
    return srgb ** 2.2


def gaussian_kernel(radius: int, sigma: float) -> np.ndarray:
    ax = np.arange(-radius, radius + 1)
    xx, yy = np.meshgrid(ax, ax)
    k = np.exp(-(xx ** 2 + yy ** 2) / (2 * sigma ** 2))
    return k / k.max()


def render(
    lngs: np.ndarray,
    lats: np.ndarray,
    colors: np.ndarray,
    weights: np.ndarray,
    width: int,
    out_path: str,
    dot_sigma: float = 1.05,
    dot_radius: int = 2,
) -> None:
    """Splat points into a mercator RGBA PNG (transparent ground)."""
    x0, x1 = np.radians(WEST), np.radians(EAST)
    y0 = merc_y(np.array([SOUTH]))[0]
    y1 = merc_y(np.array([NORTH]))[0]
    height = int(round(width * (y1 - y0) / (x1 - x0)))

    px = (np.radians(lngs) - x0) / (x1 - x0) * (width - 1)
    py = (y1 - merc_y(lats)) / (y1 - y0) * (height - 1)
    ix = np.round(px).astype(np.int32)
    iy = np.round(py).astype(np.int32)

    inside = (ix >= dot_radius) & (ix < width - dot_radius) & \
             (iy >= dot_radius) & (iy < height - dot_radius)
    ix, iy = ix[inside], iy[inside]
    c = colors[inside] * weights[inside, None]

    rgb = np.zeros((height, width, 3), dtype=np.float32)
    energy = np.zeros((height, width), dtype=np.float32)
    kernel = gaussian_kernel(dot_radius, dot_sigma)

    for dy in range(-dot_radius, dot_radius + 1):
        for dx in range(-dot_radius, dot_radius + 1):
            w = kernel[dy + dot_radius, dx + dot_radius]
            if w < 0.02:
                continue
            np.add.at(rgb, (iy + dy, ix + dx), (c * w).astype(np.float32))
            np.add.at(energy, (iy + dy, ix + dx), np.float32(w) * weights[inside].astype(np.float32))

    alpha = 1.0 - np.exp(-K * energy)
    # Chromaticity-preserving: colour = energy-weighted average of the
    # contributing trees, brightness carried by alpha.
    safe_e = np.maximum(energy, 1e-6)[..., None]
    avg = np.clip(rgb / safe_e, 0.0, 1.0)
    # Mild white bloom where many crowns stack.
    bloom = BLOOM_STRENGTH * (1.0 - np.exp(-0.5 * np.maximum(energy - BLOOM_START, 0.0)))
    avg = avg + bloom[..., None] * (1.0 - avg)
    srgb = np.clip(avg, 0.0, 1.0) ** (1 / 2.2)

    img = np.concatenate([srgb, alpha[..., None]], axis=2)
    pil = Image.fromarray((img * 255).astype(np.uint8), "RGBA")
    pil.save(out_path, "WEBP", quality=90, method=4)
    print(f"  {os.path.basename(out_path):22s} {width}x{height} "
          f"{os.path.getsize(out_path) / 1e6:.1f} MB")
    return pil


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    with open(META) as f:
        meta = json.load(f)
    cats = meta["categories"]
    cat_colors = np.array([hex_to_linear(c["color"]) for c in cats])
    species = meta["species"]
    s_norway = next(i for i, s in enumerate(species) if s[0] == "Acer platanoides")
    s_sugar = next(i for i, s in enumerate(species) if s[0] == "Acer saccharum")

    print("loading points…")
    lngs, lats, gs, ss = [], [], [], []
    with open(NDJSON) as f:
        for line in f:
            ft = json.loads(line)
            lng, lat = ft["geometry"]["coordinates"]
            p = ft["properties"]
            lngs.append(lng)
            lats.append(lat)
            gs.append(p["g"])
            ss.append(p["s"])
    lngs = np.array(lngs)
    lats = np.array(lats)
    gs = np.array(gs)
    ss = np.array(ss)
    n = len(lngs)
    print(f"{n:,} points")

    ones = np.ones(n)

    print("rendering base (all trees)…")
    base = render(lngs, lats, cat_colors[gs], ones, BASE_W,
                  os.path.join(OUT, "base.webp"))
    lo = base.resize((2048, int(base.height * 2048 / base.width)),
                     Image.LANCZOS)
    lo.save(os.path.join(OUT, "base-lo.webp"), "WEBP", quality=85, method=4)

    for i, cat in enumerate(cats):
        sel = gs == i
        print(f"rendering cat-{cat['key']} ({sel.sum():,})…")
        render(lngs[sel], lats[sel], cat_colors[gs[sel]], np.ones(sel.sum()),
               CAT_W, os.path.join(OUT, f"cat-{cat['key']}.webp"),
               dot_sigma=0.9)

    # Maple-story renders: the highlighted species at full energy, all
    # other maples dimmed to context.
    maple = gs == 0
    for name, target, hot in (
        ("maples-norway", s_norway, "#EB6F5C"),
        ("maples-sugar", s_sugar, "#FFE9B8"),
    ):
        sel_hot = maple & (ss == target)
        sel_dim = maple & (ss != target)
        lng_all = np.concatenate([lngs[sel_dim], lngs[sel_hot]])
        lat_all = np.concatenate([lats[sel_dim], lats[sel_hot]])
        col_all = np.concatenate([
            np.tile(hex_to_linear("#EB6F5C"), (sel_dim.sum(), 1)),
            np.tile(hex_to_linear(hot), (sel_hot.sum(), 1)),
        ])
        w_all = np.concatenate([
            np.full(sel_dim.sum(), 0.16),
            np.full(sel_hot.sum(), 1.35),
        ])
        print(f"rendering {name} (hot {sel_hot.sum():,} / dim {sel_dim.sum():,})…")
        render(lng_all, lat_all, col_all, w_all, CAT_W,
               os.path.join(OUT, f"{name}.webp"), dot_sigma=0.9)

    with open(os.path.join(OUT, "render.json"), "w") as f:
        json.dump({
            "bounds": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
        }, f)
    print("done.")


if __name__ == "__main__":
    main()
