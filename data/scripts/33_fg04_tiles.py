"""Build the z12-z16 shade tile pyramid, with the file count as a gate.

The two citywide rasters are EPSG:6660 at 2 m. The web wants EPSG:3857 tiles,
so z16 is warped straight off the rasters at 2.39 m/px in mercator units,
which is 1.73 m on the ground at Toronto's latitude and matches the grid.
Every shallower zoom is built by halving the level below it, voting per bit,
rather than by warping again: warping twice would let two levels of the same
pyramid disagree about the same ground.

**The count is a gate, not a report.** Cloudflare Pages refuses a deployment
over 20,000 files. That limit is not npm's, so CI cannot catch it: the
failure without this gate is a green build and a dead deploy, after the
merge. The projection runs before a single tile is written and the real
count is checked again at the end.

Empty tiles are not written. A pixel the lidar never covered reads as zero,
and zero is distinguishable from real data because every covered pixel
carries the 06:00 bit, which is set everywhere by construction.

This guide maps shade. Nothing here is temperature.

Usage: python 33_fg04_tiles.py [--limit N] [--zoom-only Z] [--dry-run]
"""

import argparse
import json
import os
import time

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds
from rasterio.windows import Window

import fg04_pyramid as pyramid
import fg04_canopy as canopy

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
PROCESSED = os.path.join(DATA, "processed", "fg04")
LAND_COVER = os.path.join(DATA, "raw", "fg04", "landcover",
                          "LandCover2018.gdb")
OUT = os.path.join(ROOT, "public", "data", "fg04")
TILES = os.path.join(OUT, "tiles")
DIST = os.path.join(ROOT, "dist")

WEB_MERCATOR = "EPSG:3857"
MERCATOR_SPAN = 20037508.342789244


def derived_is_current(path: str, sources: list[str]) -> bool:
    """A derivative is reusable only when it is at least as new as its inputs."""
    if not os.path.exists(path) or not all(os.path.exists(p) for p in sources):
        return False
    built = os.stat(path).st_mtime_ns
    inputs = []
    for source in sources:
        if os.path.isdir(source):
            nested = [os.path.join(folder, name)
                      for folder, _, names in os.walk(source)
                      for name in names]
            inputs.append(source)
            inputs.extend(nested)
        else:
            inputs.append(source)
    return all(built >= os.stat(source).st_mtime_ns for source in inputs)


def count_sources(surface: str) -> list[str]:
    """Data and implementation inputs that determine a count derivative."""
    sources = [os.path.join(PROCESSED, f"shade-{surface}.tif"),
               os.path.join(PROCESSED, "ground.tif"),
               os.path.abspath(__file__),
               os.path.abspath(canopy.__file__),
               os.path.abspath(pyramid.__file__)]
    if surface == "corrected":
        sources.append(LAND_COVER)
    return sources


def count_values(bits, ground, under_canopy=None):
    """Ground-masked shaded-frame counts, including the leaf-on override."""
    counts = pyramid.shaded_hours(bits)
    if under_canopy is not None:
        counts = np.where(ground & under_canopy,
                          pyramid.MAX_BIT + 1, counts)
    return np.where(ground, counts, 0).astype("uint8")


def count_raster(surface: str) -> str:
    """A ground-masked shaded-hours raster, written once, warped per zoom.

    This exists so every zoom can be resampled straight from the 2 m grid
    with an area average, instead of each level being aggregated from the
    level below it. Aggregating from children cannot be made unbiased here:
    a parent covers four children of which some are roof, and any rule for
    weighting them either over-represents the blocks with little ground, or
    throws them away. Measured, the two rules drifted the citywide mean from
    5.99 at z16 to 8.26 and 7.08 at z12 respectively. The map would have read
    up to 38% shadier than the figures printed beside it.

    An area average over ground is the number the ramp is meant to show, and
    GDAL computes it exactly: nodata is 0, and `Resampling.average` skips
    nodata, so each output pixel is the mean over the ground it covers and
    nothing else.
    """
    path = os.path.join(PROCESSED, f"count-{surface}.tif")
    sources = count_sources(surface)
    if derived_is_current(path, sources):
        return path

    started = time.time()
    temporary = f"{path}.tmp"
    with rasterio.open(sources[0]) as src, rasterio.open(sources[1]) as ground_src:
        trees = None
        if surface == "corrected":
            cover = gpd.read_file(LAND_COVER, layer="LandCover2018",
                                  columns=["gridcode"])
            trees = cover[cover["gridcode"] == canopy.TREE_CODE].to_crs(src.crs)
            tree_index = trees.sindex
        profile = src.profile.copy()
        profile.update(dtype="uint8", nodata=0, compress="deflate",
                       predictor=2, tiled=True, blockxsize=512,
                       blockysize=512, BIGTIFF="YES")
        try:
            with rasterio.open(temporary, "w", **profile) as sink:
                for _, window in src.block_windows(1):
                    bits = src.read(1, window=window)
                    ground = ground_src.read(1, window=window) == 1
                    under_canopy = None
                    if trees is not None:
                        transform = rasterio.windows.transform(window,
                                                               src.transform)
                        bounds = rasterio.windows.bounds(window, src.transform)
                        nearby = trees.iloc[list(tree_index.intersection(bounds))]
                        under_canopy = canopy.class_mask(
                            nearby, {canopy.TREE_CODE}, bits.shape,
                            transform, src.crs)
                    sink.write(count_values(bits, ground, under_canopy), 1,
                               window=window)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
    print(f"count raster {surface}: {time.time() - started:.0f} s", flush=True)
    return path


def ground_fraction_raster() -> str:
    """Ground as 0 or 255, so an area average gives the fraction of ground.

    Needed because averaging the count with nodata=0 DILATES the ground mask:
    any output pixel touching a sliver of ground comes back non-zero and takes
    that sliver's value. The slivers are against buildings, where shade is
    highest, so the dilation biased the map upward by 0.77 frames even at the
    native zoom. A pixel is ground here only when at least half of it is.

    No nodata on this one, deliberately. The zeros have to take part in the
    average or it is not a fraction.
    """
    path = os.path.join(PROCESSED, "ground-fraction.tif")
    source = os.path.join(PROCESSED, "ground.tif")
    if derived_is_current(path, [source]):
        return path
    with rasterio.open(source) as src:
        profile = src.profile.copy()
        profile.update(dtype="uint8", nodata=None, compress="deflate",
                       predictor=2, tiled=True, blockxsize=512,
                       blockysize=512, BIGTIFF="YES")
        with rasterio.open(path, "w", **profile) as sink:
            for _, window in src.block_windows(1):
                block = src.read(1, window=window)
                sink.write(np.where(block == 1, 255, 0).astype("uint8"), 1,
                           window=window)
    return path


def mercator_resolution(zoom: int) -> float:
    return 2.0 * MERCATOR_SPAN / (1 << zoom) / pyramid.TILE_SIZE


def existing_site_files() -> int:
    """How many files the built site already deploys, tiles excluded.

    Counted from `dist` when it exists, because a stale constant here is a
    gate that quietly stops gating.
    """
    if not os.path.isdir(DIST):
        return 0
    tiles_in_dist = os.path.join(DIST, "data", "fg04", "tiles")
    total = 0
    for folder, _, names in os.walk(DIST):
        if folder.startswith(tiles_in_dist):
            continue
        total += len(names)
    return total


def tile_path(surface: str, zoom: int, x: int, y: int) -> str:
    return os.path.join(TILES, surface, str(zoom), str(x),
                        f"{y}.{pyramid.TILE_FORMAT}")


def write_tile(surface: str, zoom: int, x: int, y: int, bits,
               count=None) -> str:
    """Lossless WebP. Measured at 39% of PNG on 120 real z16 tiles.

    Lossless matters more than it sounds: two of the three channels are a
    bitmask, and a lossy codec that moves one bit moves an hour.

    `method` is the compression effort, 0 to 6. Measured on 40 real z16
    tiles, method 6 is 1.2% smaller than method 2 and 97 times slower: 49
    tiles a minute against 4,763, which is a four hour pyramid against a
    five minute one. Method 2 it is. Method 0 is twice the bytes and not
    worth the speed.
    """
    path = tile_path(surface, zoom, x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(pyramid.encode_tile(bits, count), mode="RGB").save(
        path, format="WEBP", lossless=True, quality=100, method=2)
    return path


def read_tile(surface: str, zoom: int, x: int, y: int):
    """A written tile back as (mask, count), or None if none was written.

    The count is read rather than recomputed: above the native zoom it is the
    average of the children rather than the population count of the mask, so
    recomputing it here would throw away exactly the correction that keeps
    the zoomed-out map agreeing with the guide's figures.
    """
    path = tile_path(surface, zoom, x, y)
    if not os.path.exists(path):
        return None
    with Image.open(path) as image:
        pixels = np.asarray(image.convert("RGB"))
    return pyramid.decode_tile(pixels), pixels[:, :, 0]


def build_level(bounds, zoom: int, limit=None) -> int:
    """Warp one zoom straight off the 2 m rasters.

    The count is area-averaged over ground; the mask is nearest, because a
    bitmask cannot be averaged. Above the native zoom the two therefore
    answer slightly different questions, which the manifest says plainly:
    the count is "how many frames shaded this ground on average" and the mask
    is "was the sampled ground shaded at hour n".
    """
    resolution = mercator_resolution(zoom)
    x0, y0, x1, y1 = pyramid.tile_range(bounds, zoom)
    size = pyramid.TILE_SIZE
    transform = rasterio.transform.from_origin(
        -MERCATOR_SPAN + x0 * size * resolution,
        MERCATOR_SPAN - y0 * size * resolution,
        resolution, resolution)
    width = (x1 - x0 + 1) * size
    height = (y1 - y0 + 1) * size

    written = 0
    started = time.time()
    handles = []
    try:
        warped = {}
        ground_src = rasterio.open(ground_fraction_raster())
        handles.append(ground_src)
        ground_vrt = WarpedVRT(
            ground_src, crs=WEB_MERCATOR, transform=transform,
            width=width, height=height, resampling=Resampling.average)
        handles.append(ground_vrt)
        for surface in pyramid.SURFACES:
            mask_src = rasterio.open(
                os.path.join(PROCESSED, f"shade-{surface}.tif"))
            count_src = rasterio.open(count_raster(surface))
            handles += [mask_src, count_src]
            common = dict(crs=WEB_MERCATOR, transform=transform,
                          width=width, height=height)
            warped[surface] = {
                # nodata=0 is safe on the bitmask: 0 already means "no data"
                # there, because every covered pixel carries the 06:00 bit.
                "mask": WarpedVRT(mask_src, resampling=Resampling.nearest,
                                  nodata=0, **common),
                # NOT nodata=0 here. The count raster already declares 0 as
                # nodata, and passing it again overrides the SOURCE nodata,
                # which makes the warper backfill every not-ground pixel from
                # a neighbour. That silently turned a 44.7% ground mask into
                # 100% ground.
                "count": WarpedVRT(count_src, resampling=Resampling.average,
                                   **common),
            }
        handles += [vrt for pair in warped.values() for vrt in pair.values()]

        for x, y in pyramid.tiles_for_bounds(bounds, zoom):
            window = Window((x - x0) * size, (y - y0) * size, size, size)
            # Majority ground, not "touched any ground".
            ground = ground_vrt.read(1, window=window) >= 128
            if not ground.any():
                continue
            for surface in pyramid.SURFACES:
                count = warped[surface]["count"].read(1, window=window)
                bits = warped[surface]["mask"].read(1, window=window)
                # One ground definition for both channels.
                count = np.where(ground, np.maximum(count, 1), 0)
                bits = np.where(ground, bits, 0).astype(np.uint16)
                write_tile(surface, zoom, x, y, bits,
                           np.minimum(count, pyramid.MAX_BIT + 1).astype(np.uint8))
                written += 1
            if limit and written >= limit * len(pyramid.SURFACES):
                break
    finally:
        for handle in handles:
            handle.close()

    print(f"z{zoom}: {written} files, {time.time() - started:.0f} s",
          flush=True)
    return written


def written_files():
    for folder, _, names in os.walk(TILES):
        for name in names:
            yield os.path.join(folder, name)


def build(limit=None, dry_run=False) -> None:
    raster = os.path.join(PROCESSED, "shade-raw.tif")
    if not os.path.exists(raster):
        raise SystemExit("run 31_build_shade.py first")
    with rasterio.open(raster) as src:
        bounds = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
    print(f"bounds {[round(v, 5) for v in bounds]}")

    projected = pyramid.project_file_count(bounds)
    existing = existing_site_files()
    for zoom in range(pyramid.MIN_ZOOM, pyramid.MAX_ZOOM + 1):
        print(f"  z{zoom}: {projected[zoom]:,} tiles projected")
    print(f"  total {projected['total']:,} tiles")
    print(f"  hosting: {pyramid.HOSTING}")
    if pyramid.HOSTING == "r2":
        print(f"  deployment stays at {existing:,} + 1 manifest of "
              f"{pyramid.CLOUDFLARE_FILE_LIMIT:,}; tiles go to R2")
    else:
        print(f"  deployment would be {projected['total'] + 1 + existing:,} "
              f"of {pyramid.CLOUDFLARE_FILE_LIMIT:,}")

    # The gate, before anything is written. On R2 the tiles are not part of
    # the deployment, so only the manifest counts against Pages; the tile
    # projection is still printed because a pyramid that would not fit in a
    # deployment is worth knowing about either way.
    deployed = 1 if pyramid.HOSTING == "r2" else projected["total"] + 1
    pyramid.check_file_budget(deployed, existing)
    print(f"  z17 would be {pyramid.tile_count(bounds, 17):,} tiles on its "
          f"own, which is why z{pyramid.MAX_ZOOM} is the ceiling")
    if dry_run:
        return

    written = {}
    for zoom in range(pyramid.MAX_ZOOM, pyramid.MIN_ZOOM - 1, -1):
        written[zoom] = build_level(bounds, zoom, limit=limit)
        if limit:
            break

    paths = list(written_files())
    pyramid.check_file_sizes(paths)
    total_bytes = sum(os.path.getsize(path) for path in paths)

    os.makedirs(OUT, exist_ok=True)
    entry = pyramid.manifest(bounds, tiles_written=len(paths),
                             projected=projected)
    entry["tilesWrittenByZoom"] = {str(zoom): count
                                   for zoom, count in sorted(written.items())}
    entry["bytesTotal"] = total_bytes
    with open(os.path.join(OUT, "manifest.json"), "w") as handle:
        json.dump(entry, handle, indent=2, sort_keys=True)

    print(f"\n{len(paths):,} tiles written against {projected['total']:,} "
          f"projected, {total_bytes / 1e6:.1f} MB, "
          f"largest {max(os.path.getsize(p) for p in paths) / 1024:.0f} KB")
    if pyramid.HOSTING == "r2":
        print(f"deployment stays at {existing + 1:,} files of "
              f"{pyramid.CLOUDFLARE_FILE_LIMIT:,}; run 34_fg04_upload.py "
              f"to put the tiles on R2")
    else:
        print(f"deployment would be {len(paths) + 1 + existing:,} files of "
              f"{pyramid.CLOUDFLARE_FILE_LIMIT:,}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None,
                        help="stop after N native tiles, for measurement")
    parser.add_argument("--dry-run", action="store_true",
                        help="run the gate and the projection only")
    args = parser.parse_args()
    build(limit=args.limit, dry_run=args.dry_run)
