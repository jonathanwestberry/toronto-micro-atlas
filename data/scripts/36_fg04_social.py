"""The shareable frame: one block, at one in the afternoon and at six.

The guide currently falls back to `og-default.jpg`. This builds its own.

**The block is picked from the data, not by eye.** Every candidate block in
the city is scored by how much more of its ground is shaded at 18:00 than at
13:00, and the winner is the largest swing that also holds enough ground to
be legible and enough named street to be somewhere a reader places. Picking
by eye would mean picking the block that flatters the argument.

**The frame is the picture and nothing else.** No title, hours, date or key
is set over it: the page's title and description travel with every link
preview, and the page's og:image:alt says which panel is which hour and what
the two colours mean. 13:00 is on the left, 18:00 on the right.

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
from PIL import Image, ImageDraw
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

MIN_GROUND = 0.30           # a block that is mostly lake shows nothing
MIN_ARTERIAL_M = 200.0      # and one nobody can place shows nothing either

# The guide's own selected-hour colours (src/styles/fg04.css), so the card
# looks like the map it advertises: --fg04-selected-sunlit,
# --fg04-selected-shaded, and the White ground where nothing was sampled.
# Yellow type on the Purple 25 bars reads at 8.56:1.
SUNLIT = (0xFF, 0xCB, 0x03)      # Yellow
SHADED = (0x34, 0x2E, 0x40)      # Purple 25 / Black 75
BUILT = (0xFF, 0xFF, 0xFF)       # White, anything not ground

def add_divider(image):
    """Split the two panels, so the shared geography reads as two moments
    even where both carry the same colour at their touching edges."""
    frame = image.copy()
    ImageDraw.Draw(frame).rectangle((598, 0, 602, PANEL_H), fill=SHADED)
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
    return add_divider(Image.fromarray(canvas, mode="RGB"))


def main(dry_run):
    best, early, late, crs = choose(SURFACE)
    print(json.dumps({k: v for k, v in best.items() if k != "bounds"},
                     indent=2))
    print(f"bounds {best['bounds']} in {crs}")

    image = render(best, early, late, SURFACE)
    os.makedirs(SOCIAL, exist_ok=True)
    # Versioned because share platforms cache by URL: a recoloured card at the
    # old path would keep showing the old one. Earlier versions stay in
    # public/social so posts that already carry them do not break.
    out = os.path.join(SOCIAL, "og-out-of-the-sun-v4.jpg")
    if dry_run:
        print(f"dry run, not writing {out}")
        return
    image.save(out, "JPEG", quality=88, optimize=True)
    print(f"wrote {out} at {image.size[0]}x{image.size[1]}")

    record = dict(best)
    record["surface"] = SURFACE
    record["hours"] = [EARLY_HOUR, LATE_HOUR]
    record["panels"] = ["13:00, left", "18:00, right"]
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
