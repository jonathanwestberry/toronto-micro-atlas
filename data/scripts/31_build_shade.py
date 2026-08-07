"""Compute citywide hour bitmasks, uncorrected and leaf-on corrected.

Tiles are resampled once into one mosaic per surface, then processed as an
8 km windowed read from that mosaic with a margin, because a 352 m tower
throws 2.5 km at 20:00 and unbuffered per-tile processing silently truncates
long shadows while still looking plausible.

Calling `rasterio.merge` per window re-decompressed every overlapped tile
about 3.9 times. The mosaic pays that once instead. It is worth about 207 s
of a 3.69 hour run rather than the bulk of it, and `fg04_mosaic` carries the
measurement and the proof that the two paths return the same array.

The margin is sized from the tallest object actually present near each
window, not from a citywide worst case. Most of Toronto tops out around
40 m, which needs a 300 m margin rather than 2,927 m, and the sweep cost
falls with it. Correctness holds because an object shorter than the local
maximum cannot cast further than the local maximum does.

Outputs, all uint16 or uint8 in EPSG:6660 at the requested resolution:
  shade-raw.tif        hour bitmask on the measured leaf-off surface
  shade-corrected.tif  hour bitmask after the leaf-on canopy correction
  ground.tif           1 where the measured surface is under 2 m
  correction-report.json

Usage: python 31_build_shade.py [--resolution 1.0] [--window 8000] [--limit N]
"""

import argparse
import json
import os
import time

import geopandas as gpd
import numpy as np
import rasterio
from affine import Affine
from rasterio.windows import Window, from_bounds

import fg04_canopy as canopy
import fg04_mosaic as mosaic
import fg04_shadow as shadow
import fg04_solar as solar

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
RAW = os.path.join(DATA, "raw", "fg04")
OUT = os.path.join(DATA, "processed", "fg04")
LAND_COVER = os.path.join(RAW, "landcover", "LandCover2018.gdb")

# The CN Tower measures 537.0 m in this lidar, in tile 630000/4833000. The
# product plan records the downtown peak as 352.6 m, but that figure came
# from the tile immediately north, which the tower does not stand in, so a
# per-tile maximum was recorded as a citywide one. A 400 m ceiling clipped
# the tower by 137 m and lost a kilometre of its 20:00 shadow. 600 m clears
# the real maximum with headroom while still catching lidar spikes.
MAX_HEIGHT_M = mosaic.MAX_HEIGHT_M
GROUND_MAX_M = 2.0          # the pre-registered definition of a ground pixel
WINDOW_M = 8000.0

# The nodata sentinel the mosaics carry, and the range that decides which
# values are real elevations rather than sentinels. Both live in fg04_mosaic
# now, because the mosaic is where they are written.
MERGE_FILL = mosaic.FILL
MIN_REAL_M = mosaic.MIN_REAL_M
MAX_REAL_M = mosaic.MAX_REAL_M

real = mosaic.real
snap = mosaic.snap
tile_index = mosaic.tile_index
intersecting = mosaic.intersecting
union_bounds = mosaic.union_bounds


def casting_frames(frames):
    """Frames that actually cast. The rest are shaded everywhere anyway.

    The 06:00 frame sits at 0.38 degrees, at or below `shadow.HORIZON_DEG`,
    so `cast_shadow` returns an all-true mask for it without reading the
    surface. Including it in the buffer arithmetic would ask for a 60 km
    margin, because 1 / tan(0.38 degrees) is 151.
    """
    return [f for f in frames if f.altitude > shadow.HORIZON_DEG]


def core_windows(city, window_m):
    left, bottom, right, top = city
    xs = np.arange(left, right, window_m)
    ys = np.arange(bottom, top, window_m)
    return [(x, y, min(x + window_m, right), min(y + window_m, top))
            for y in ys for x in xs]


def mosaic_paths(resolution):
    return (os.path.join(OUT, f"mosaic-dsm-{resolution:g}m.tif"),
            os.path.join(OUT, f"mosaic-dtm-{resolution:g}m.tif"))


def normalised(dsm_path, dtm_path, bounds, resolution):
    """DSM minus DTM, with nodata on either side knocked out to zero.

    Returns (None, None, None) where the window falls entirely outside the
    lidar, which the old per-window merge signalled by having no tiles to
    merge and the mosaic signals by reading back all fill.
    """
    height, transform, valid = mosaic.normalised_window(
        dsm_path, dtm_path, bounds, resolution)
    if not valid.any():
        return None, None, None
    return height, transform, valid


def crop_margin(array, margin_px):
    if margin_px <= 0:
        return array
    return array[margin_px:-margin_px, margin_px:-margin_px]


def build(resolution: float, window_m: float, limit: int | None) -> None:
    frames = solar.hourly_frames()
    casting = casting_frames(frames)
    lowest = min(frame.altitude for frame in casting)
    worst_buffer = shadow.required_buffer(MAX_HEIGHT_M, lowest)
    print(f"{len(frames)} frames, {len(casting)} of them casting, "
          f"lowest casting sun {lowest:.2f} deg, "
          f"worst-case buffer {worst_buffer:.0f} m")

    dsm_index = tile_index(os.path.join(RAW, "dsm"))
    dtm_index = tile_index(os.path.join(RAW, "dtm"))
    if limit:
        dsm_index = dsm_index[:limit]
        keep = {os.path.basename(p).replace("_DSM", "_DTM")
                for p, _, _ in dsm_index}
        dtm_index = [x for x in dtm_index if os.path.basename(x[0]) in keep]
    if not dsm_index:
        raise SystemExit("no DSM tiles found; run 30_download_fg04.py first")

    crs = dsm_index[0][2]
    city = snap(union_bounds(dsm_index), resolution)
    windows = core_windows(city, window_m)
    print(f"{len(dsm_index)} tiles, crs {crs}")
    print(f"city {city[2]-city[0]:,.0f} x {city[3]-city[1]:,.0f} m, "
          f"{len(windows)} window(s) of {window_m:.0f} m")

    # Pay the decompress-and-resample cost once. Every window after this is
    # a read from a tiled 2 m mosaic rather than a fresh merge of about 119
    # source tiles: 1.9 s instead of 14.1 s, against 85 s spent here.
    os.makedirs(OUT, exist_ok=True)
    dsm_mosaic, dtm_mosaic = mosaic_paths(resolution)
    for name, index, path in (("dsm", dsm_index, dsm_mosaic),
                              ("dtm", dtm_index, dtm_mosaic)):
        if mosaic.mosaic_is_current(path, index, city, resolution):
            print(f"{name} mosaic already current: {os.path.basename(path)}")
            continue
        started_mosaic = time.time()
        mosaic.build_mosaic(index, city, resolution, path)
        print(f"{name} mosaic: {len(index)} tiles into "
              f"{os.path.basename(path)} in "
              f"{time.time() - started_mosaic:.0f} s", flush=True)

    cover = gpd.read_file(LAND_COVER, layer="LandCover2018",
                          columns=["gridcode"])
    print(f"land cover: {len(cover)} polygons in {cover.crs}")

    width = int(round((city[2] - city[0]) / resolution))
    height = int(round((city[3] - city[1]) / resolution))
    transform = rasterio.transform.from_origin(
        city[0], city[3], resolution, resolution)
    print(f"output grid {width} x {height} px")

    os.makedirs(OUT, exist_ok=True)
    profile = dict(driver="GTiff", width=width, height=height, count=1,
                   crs=crs, transform=transform, compress="deflate",
                   predictor=2, tiled=True, blockxsize=512, blockysize=512,
                   BIGTIFF="YES")

    totals = {"canopy_pixels": 0, "raised_pixels": 0,
              "rise_sum_m": 0.0, "max_rise_m": 0.0,
              "measured_pixels": 0, "defaulted_pixels": 0}
    started = time.time()

    with rasterio.open(os.path.join(OUT, "shade-raw.tif"), "w",
                       dtype="uint16", nodata=0, **profile) as raw_out, \
         rasterio.open(os.path.join(OUT, "shade-corrected.tif"), "w",
                       dtype="uint16", nodata=0, **profile) as corr_out, \
         rasterio.open(os.path.join(OUT, "ground.tif"), "w",
                       dtype="uint8", nodata=255, **profile) as ground_out:

        for number, core in enumerate(windows, start=1):
            padded = (core[0] - worst_buffer, core[1] - worst_buffer,
                      core[2] + worst_buffer, core[3] + worst_buffer)
            surface, padded_transform, valid = normalised(
                dsm_mosaic, dtm_mosaic, snap(padded, resolution), resolution)
            if surface is None:
                print(f"  window {number}/{len(windows)}: no coverage, skipped")
                continue

            # Size the real margin to the tallest thing actually near here.
            # An object shorter than the local maximum cannot cast further
            # than the local maximum does, so trimming to it is lossless.
            local_max = float(surface.max())
            margin_m = min(worst_buffer,
                           shadow.required_buffer(max(local_max, 1.0), lowest))
            trim = int(round((worst_buffer - margin_m) / resolution))
            trim = max(0, min(trim, (min(surface.shape) - 1) // 2))
            if trim > 0:
                surface = surface[trim:-trim, trim:-trim]
                valid = valid[trim:-trim, trim:-trim]
            margin_px = int(round(margin_m / resolution))

            # Take the grid from the mosaic itself. Rebuilding it from the
            # window bounds risks a sub-pixel offset, which would slide the
            # canopy mask off the surface it is meant to correct.
            surface_transform = padded_transform * Affine.translation(trim, trim)
            # Restrict canopy to ground the lidar actually covered. The land
            # cover spans the whole city, so without this every tree polygon
            # over a coverage gap, the lake edge or beyond the city limit
            # reads as height zero, is judged bare, and is raised to a
            # phantom 8 m tree that then casts a shadow.
            tree = canopy.class_mask(cover, {canopy.TREE_CODE},
                                     surface.shape, surface_transform, crs)
            tree &= valid
            corrected, detail = canopy.correct_leaf_off(
                surface, tree, with_detail=True)
            report = canopy.correction_report(surface, corrected, tree)
            totals["canopy_pixels"] += report["canopy_pixels"]
            totals["raised_pixels"] += report["raised_pixels"]
            totals["rise_sum_m"] += report["mean_rise_m"] * report["raised_pixels"]
            totals["max_rise_m"] = max(totals["max_rise_m"], report["max_rise_m"])
            totals["measured_pixels"] += detail["measured_pixels"]
            totals["defaulted_pixels"] += detail["defaulted_pixels"]

            cast_height = max(local_max, 1.0)
            raw_bits = shadow.hour_bitmask(
                surface, frames, resolution, max_height=cast_height)
            corr_bits = shadow.hour_bitmask(
                corrected, frames, resolution,
                max_height=max(float(corrected.max()), 1.0))

            ground = (surface < GROUND_MAX_M) & valid

            window = from_bounds(core[0], core[1], core[2], core[3], transform)
            window = Window(int(round(window.col_off)),
                            int(round(window.row_off)),
                            int(round(window.width)),
                            int(round(window.height)))
            for data, sink, dtype in ((raw_bits, raw_out, "uint16"),
                                      (corr_bits, corr_out, "uint16"),
                                      (ground, ground_out, "uint8")):
                block = crop_margin(data, margin_px)
                block = block[:window.height, :window.width]
                sink.write(block.astype(dtype), 1, window=window)

            elapsed = time.time() - started
            print(f"  window {number}/{len(windows)}: max {local_max:6.1f} m, "
                  f"margin {margin_m:6.0f} m, "
                  f"{surface.shape[0]}x{surface.shape[1]} px, "
                  f"{elapsed/number:6.1f} s/window", flush=True)

    raised = totals["raised_pixels"]
    summary = {
        "resolution_m": resolution,
        "window_m": window_m,
        "frames": len(frames),
        "casting_frames": len(casting),
        "worst_case_buffer_m": round(worst_buffer, 1),
        "canopy_pixels": totals["canopy_pixels"],
        "raised_pixels": raised,
        "mean_rise_m": round(totals["rise_sum_m"] / raised, 3) if raised else 0.0,
        "max_rise_m": round(totals["max_rise_m"], 3),
        # How much of the leaf-on correction is measured from neighbouring
        # crowns and how much is the assumed default height. A low measured
        # share means the corrected figures are largely a modelled input and
        # the guide must say so rather than call them corrected from data.
        "measured_pixels": totals["measured_pixels"],
        "defaulted_pixels": totals["defaulted_pixels"],
        "measured_share": (round(totals["measured_pixels"] / raised, 4)
                           if raised else 0.0),
        "seconds": round(time.time() - started, 1),
    }
    with open(os.path.join(OUT, "correction-report.json"), "w") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--resolution", type=float, default=1.0)
    parser.add_argument("--window", type=float, default=WINDOW_M)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    build(args.resolution, args.window, args.limit)
