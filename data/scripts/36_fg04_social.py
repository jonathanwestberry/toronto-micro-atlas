"""The shareable frame: one block, at one in the afternoon and at six.

The guide currently falls back to `og-default.jpg`. This builds its own.

**The block is picked from the data, not by eye.** Every candidate block in
the city is scored by how much more of its ground is shaded at 18:00 than at
13:00, and the winner is the largest swing that also holds enough ground to
be legible and enough named street to be somewhere a reader places. Picking
by eye would mean picking the block that flatters the argument.

**The frame carries only the context needed to travel.** Social cards are
frequently cropped, screenshotted or detached from the page, so the title,
hours, date, measured surface and two-colour key are part of the image. The
page repeats that context in alt text for readers who cannot see it.

**This shows shadow, not temperature.** Dark is where the sun was blocked at
that hour and nothing else. The palette is the guide's own shade ramp read
from `src/styles/fg04.css`: the end that means sun nearly all day, and the
end that means blocked almost throughout.

Usage: python 36_fg04_social.py [--dry-run]
"""

import argparse
import json
import os
import warnings

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from rasterio.windows import Window

import fg04_solar as solar
from fg04_stats import bit_for_hour, block_swing

warnings.filterwarnings(
    "ignore",
    message="Setting the shape on a NumPy array has been deprecated.*",
    category=DeprecationWarning,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
PROCESSED = os.path.join(DATA, "processed", "fg04")
PROOF = os.path.join(DATA, "proof", "fg04")
SOCIAL = os.path.join(ROOT, "public", "social")

# 1200x630 is the Open Graph frame. Two panels of the same block, so each
# panel is 600 px wide, and at the raster's own 2 m the block is
# 1200 x 1260 m of Toronto with no resampling anywhere.
PANEL_W, PANEL_H = 600, 630
EARLY_HOUR, LATE_HOUR = 13, 18
SURFACE = "raw"

# The share card is the one surface where the guide's title is a raster, so a
# rename that misses this file ships a card contradicting the page. Declared
# once and used by both the drawing and the proof record.
TITLE = "Out of the Sun"
MIN_GROUND = 0.30           # a block that is mostly lake shows nothing
MIN_ARTERIAL_M = 200.0      # and one nobody can place shows nothing either

# The guide's ramp, both ends. `--fg04-shade-1` is one shaded hour and
# `--fg04-shade-6` is blocked almost throughout, so a single frame's sunlit
# and shaded ground belong at those two ends.
SUNLIT = (0xFB, 0xF8, 0xC8)      # --c-pale-lemon
SHADED = (0x1A, 0x1F, 0x2A)      # --c-contour
BUILT = (0xD3, 0xCF, 0xA6)       # --c-kraft, anything not ground

DISPLAY_FONTS = (
    "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
)
UI_FONTS = (
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
)


def load_font(paths, size):
    """Load the atlas-like local font, with a portable system fallback."""
    for path in paths:
        if os.path.exists(path):
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default(size=size)


def add_editorial_context(image):
    """Make the data frame readable when it travels without the guide."""
    frame = image.copy()
    draw = ImageDraw.Draw(frame)
    display_46 = load_font(DISPLAY_FONTS, 46)
    display_66 = load_font(DISPLAY_FONTS, 66)
    ui_14 = load_font(UI_FONTS, 14)
    ui_16 = load_font(UI_FONTS, 16)

    # The divider makes the shared geography explicit even where both panels
    # happen to carry the same colour at their touching edges.
    draw.rectangle((598, 0, 602, 528), fill=SHADED)

    for left, eyebrow, hour in (
        (28, "TORONTO", "13:00"),
        (628, "SAME GROUND", "18:00"),
    ):
        draw.rectangle((left, 28, left + 232, 104), fill=SHADED)
        draw.text((left + 18, 38), eyebrow, font=ui_14, fill=SUNLIT)
        draw.text((left + 16, 49), hour, font=display_46, fill=SUNLIT)

    # One compact footer gives the title a dependable reading surface without
    # shrinking or resampling the selected raster block.
    draw.rectangle((0, 528, 1200, 630), fill=SHADED)
    draw.text((38, 530), TITLE.upper(), font=display_66, fill=SUNLIT)

    draw.text((680, 544), "MEASURED, LEAF-OFF  |  21 JULY 2026",
              font=ui_16, fill=SUNLIT)
    legend_y = 582
    draw.rectangle((680, legend_y, 706, legend_y + 20),
                   fill=SHADED, outline=BUILT, width=2)
    draw.text((718, legend_y + 1), "SHADED GROUND", font=ui_14, fill=SUNLIT)
    draw.rectangle((912, legend_y, 938, legend_y + 20), fill=SUNLIT)
    draw.text((950, legend_y + 1), "SUNLIT GROUND", font=ui_14, fill=SUNLIT)
    return frame


def candidates(width, height):
    """Non-overlapping blocks covering the raster."""
    return [(col, row)
            for row in range(0, height - PANEL_H + 1, PANEL_H)
            for col in range(0, width - PANEL_W + 1, PANEL_W)]


def named_arterial_metres(bounds, arterial, index):
    """Metres of named arterial inside a block, for placing it."""
    from shapely.geometry import box

    frame = box(*bounds)
    hits = list(index.intersection(bounds))
    if not hits:
        return 0.0, []
    inside = arterial.iloc[hits]
    clipped = inside.geometry.intersection(frame)
    keep = ~clipped.is_empty
    if not keep.any():
        return 0.0, []
    names = sorted({str(n) for n in inside[keep]["name"] if n})
    return float(clipped[keep].length.sum()), names


def choose(surface):
    raw_path = os.path.join(PROCESSED, f"shade-{surface}.tif")
    ground_path = os.path.join(PROCESSED, "ground.tif")
    for path in (raw_path, ground_path):
        if not os.path.exists(path):
            raise SystemExit(f"{path} is missing; run 31_build_shade.py first")

    frames = solar.hourly_frames()
    early = bit_for_hour(frames, EARLY_HOUR)
    late = bit_for_hour(frames, LATE_HOUR)
    print(f"{EARLY_HOUR}:00 is bit {early}, {LATE_HOUR}:00 is bit {late}")

    with rasterio.open(raw_path) as src:
        crs, transform = src.crs, src.transform
        width, height = src.width, src.height

    arterial = gpd.read_file(os.path.join(
        ROOT, "public", "data", "streets-major.geojson")).to_crs(crs)
    arterial = arterial[arterial["tier"] == "major"].reset_index(drop=True)
    index = arterial.sindex

    best = None
    spots = candidates(width, height)
    with rasterio.open(raw_path) as bits_src, \
         rasterio.open(ground_path) as ground_src:
        for number, (col, row) in enumerate(spots, start=1):
            window = Window(col, row, PANEL_W, PANEL_H)
            ground = ground_src.read(1, window=window) == 1
            if ground.mean() < MIN_GROUND:
                continue
            bits = bits_src.read(1, window=window)
            swing = block_swing(((bits >> early) & 1).astype(bool),
                                ((bits >> late) & 1).astype(bool),
                                ground, MIN_GROUND)
            if swing is None:
                continue
            bounds = rasterio.windows.bounds(window, transform)
            metres, names = named_arterial_metres(bounds, arterial, index)
            if metres < MIN_ARTERIAL_M or not names:
                continue
            if best is None or swing > best["swing"]:
                best = {"col": col, "row": row, "swing": swing,
                        "bounds": bounds, "streets": names,
                        "arterial_m": round(metres, 1),
                        "ground_fraction": round(float(ground.mean()), 4)}
            if number % 100 == 0:
                print(f"  scored {number}/{len(spots)}", flush=True)

    if best is None:
        raise SystemExit("no block cleared the ground and street floors")
    return best, early, late, crs


def render(best, early, late, surface):
    raw_path = os.path.join(PROCESSED, f"shade-{surface}.tif")
    ground_path = os.path.join(PROCESSED, "ground.tif")
    window = Window(best["col"], best["row"], PANEL_W, PANEL_H)
    with rasterio.open(raw_path) as bits_src, \
         rasterio.open(ground_path) as ground_src:
        bits = bits_src.read(1, window=window)
        ground = ground_src.read(1, window=window) == 1

    canvas = np.zeros((PANEL_H, PANEL_W * 2, 3), dtype=np.uint8)
    for panel, bit in enumerate((early, late)):
        shaded = ((bits >> bit) & 1).astype(bool)
        tile = np.empty((PANEL_H, PANEL_W, 3), dtype=np.uint8)
        tile[:] = BUILT
        tile[ground & ~shaded] = SUNLIT
        tile[ground & shaded] = SHADED
        canvas[:, panel * PANEL_W:(panel + 1) * PANEL_W] = tile
    return add_editorial_context(Image.fromarray(canvas, mode="RGB"))


def main(dry_run):
    best, early, late, crs = choose(SURFACE)
    print(json.dumps({k: v for k, v in best.items() if k != "bounds"},
                     indent=2))
    print(f"bounds {best['bounds']} in {crs}")

    image = render(best, early, late, SURFACE)
    os.makedirs(SOCIAL, exist_ok=True)
    out = os.path.join(SOCIAL, "og-throwing-shade.jpg")
    if dry_run:
        print(f"dry run, not writing {out}")
        return
    image.save(out, "JPEG", quality=88, optimize=True)
    print(f"wrote {out} at {image.size[0]}x{image.size[1]}")

    record = dict(best)
    record["surface"] = SURFACE
    record["hours"] = [EARLY_HOUR, LATE_HOUR]
    record["image_text"] = {
        "title": TITLE,
        "panels": ["Toronto, 13:00", "Same ground, 18:00"],
        "surface": "Measured, leaf-off",
        "date": "21 July 2026",
        "legend": ["Shaded ground", "Sunlit ground"],
    }
    record["dimensions"] = [image.size[0], image.size[1]]
    record["bounds"] = [round(v, 2) for v in best["bounds"]]
    record["crs"] = str(crs)
    with open(os.path.join(PROOF, "social-frame.json"), "w") as handle:
        json.dump(record, handle, indent=2)
        handle.write("\n")


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    main(args.dry_run)
