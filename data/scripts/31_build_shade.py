"""Compute citywide hour bitmasks, uncorrected and leaf-on corrected.

Tiles are processed with a buffer, because a 352 m tower throws 2.5 km at
20:00 and unbuffered per-tile processing silently truncates long shadows.

Usage: python 31_build_shade.py [--resolution 1.0] [--limit N]
"""

import argparse
import glob
import os

import numpy as np
import rasterio
from rasterio.merge import merge

import fg04_canopy as canopy
import fg04_shadow as shadow
import fg04_solar as solar

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
RAW = os.path.join(DATA, "raw", "fg04")
OUT = os.path.join(DATA, "processed", "fg04")
MAX_HEIGHT_M = 400.0


def casting_frames(frames):
    """Frames that actually cast. The rest are shaded everywhere anyway.

    The 06:00 frame sits at 0.38 degrees, at or below `shadow.HORIZON_DEG`,
    so `cast_shadow` returns an all-true mask for it without reading the
    surface. Including it in the buffer arithmetic would ask for a 60 km
    margin, because 1 / tan(0.38 degrees) is 151.
    """
    return [f for f in frames if f.altitude > shadow.HORIZON_DEG]


def build(resolution: float, limit: int | None) -> None:
    frames = solar.hourly_frames()
    casting = casting_frames(frames)
    lowest = min(frame.altitude for frame in casting)
    buffer_m = shadow.required_buffer(MAX_HEIGHT_M, lowest)
    print(f"{len(frames)} frames, {len(casting)} of them casting, "
          f"lowest casting sun {lowest:.2f} deg, buffer {buffer_m:.0f} m")

    dsm_paths = sorted(glob.glob(os.path.join(RAW, "dsm", "*.tif")))[:limit]
    os.makedirs(OUT, exist_ok=True)
    print(f"processing {len(dsm_paths)} tiles at {resolution} m")
    raise SystemExit(
        "Stop here and read the note below before implementing the loop.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--resolution", type=float, default=1.0)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    build(args.resolution, args.limit)
