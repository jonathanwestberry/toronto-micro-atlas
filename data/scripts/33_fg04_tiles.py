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

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds
from rasterio.windows import Window

import fg04_pyramid as pyramid

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
PROCESSED = os.path.join(DATA, "processed", "fg04")
OUT = os.path.join(ROOT, "public", "data", "fg04")
TILES = os.path.join(OUT, "tiles")
DIST = os.path.join(ROOT, "dist")

WEB_MERCATOR = "EPSG:3857"
MERCATOR_SPAN = 20037508.342789244


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


def write_tile(surface: str, zoom: int, x: int, y: int, bits) -> str:
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
    Image.fromarray(pyramid.encode_tile(bits), mode="RGB").save(
        path, format="WEBP", lossless=True, quality=100, method=2)
    return path


def read_tile(surface: str, zoom: int, x: int, y: int):
    """A written tile back as a mask, or None where none was written."""
    path = tile_path(surface, zoom, x, y)
    if not os.path.exists(path):
        return None
    with Image.open(path) as image:
        return pyramid.decode_tile(np.asarray(image.convert("RGB")))


def build_native(bounds, limit=None) -> int:
    """Warp z16 straight off the citywide rasters."""
    resolution = mercator_resolution(pyramid.MAX_ZOOM)
    x0, y0, x1, y1 = pyramid.tile_range(bounds, pyramid.MAX_ZOOM)
    size = pyramid.TILE_SIZE
    transform = rasterio.transform.from_origin(
        -MERCATOR_SPAN + x0 * size * resolution,
        MERCATOR_SPAN - y0 * size * resolution,
        resolution, resolution)
    width = (x1 - x0 + 1) * size
    height = (y1 - y0 + 1) * size
    print(f"z{pyramid.MAX_ZOOM}: warping to {width} x {height} px at "
          f"{resolution:.4f} mercator m/px", flush=True)

    written = 0
    considered = 0
    started = time.time()
    sources = {name: rasterio.open(os.path.join(PROCESSED, f"shade-{name}.tif"))
               for name in ("raw", "corrected")}
    try:
        warped = {
            name: WarpedVRT(src, crs=WEB_MERCATOR, transform=transform,
                            width=width, height=height,
                            resampling=Resampling.nearest, nodata=0)
            for name, src in sources.items()}
        try:
            for x, y in pyramid.tiles_for_bounds(bounds, pyramid.MAX_ZOOM):
                considered += 1
                window = Window((x - x0) * size, (y - y0) * size, size, size)
                raw = warped["raw"].read(1, window=window)
                # Every covered pixel carries the 06:00 bit, so an all-zero
                # tile is ground the lidar never saw rather than ground that
                # was never shaded.
                if not raw.any():
                    continue
                corrected = warped["corrected"].read(1, window=window)
                write_tile("raw", pyramid.MAX_ZOOM, x, y,
                           raw.astype(np.uint16))
                write_tile("corrected", pyramid.MAX_ZOOM, x, y,
                           corrected.astype(np.uint16))
                written += 1
                if written % 500 == 0:
                    print(f"  {written} written of {considered} considered, "
                          f"{time.time() - started:.0f} s", flush=True)
                if limit and written >= limit:
                    break
        finally:
            for vrt in warped.values():
                vrt.close()
    finally:
        for src in sources.values():
            src.close()
    # `written` counts coordinates; each writes one file per surface. The
    # overview levels count files, so convert here rather than leave the
    # manifest reporting two different things under one key.
    files = written * len(pyramid.SURFACES)
    print(f"z{pyramid.MAX_ZOOM}: {written} coordinates, {files} files, "
          f"{considered - written} empty, {time.time() - started:.0f} s",
          flush=True)
    return files


def build_overview(bounds, zoom: int) -> int:
    """Halve the level below, voting per bit. Never a second warp."""
    written = 0
    started = time.time()
    empty = np.zeros((pyramid.TILE_SIZE, pyramid.TILE_SIZE), dtype=np.uint16)
    for x, y in pyramid.tiles_for_bounds(bounds, zoom):
        for surface in pyramid.SURFACES:
            children = {(dx, dy): read_tile(surface, zoom + 1,
                                            x * 2 + dx, y * 2 + dy)
                        for dx in (0, 1) for dy in (0, 1)}
            if not any(child is not None for child in children.values()):
                continue
            stacked = np.zeros((pyramid.TILE_SIZE * 2, pyramid.TILE_SIZE * 2),
                               dtype=np.uint16)
            for (dx, dy), child in children.items():
                block = empty if child is None else child
                stacked[dy * pyramid.TILE_SIZE:(dy + 1) * pyramid.TILE_SIZE,
                        dx * pyramid.TILE_SIZE:(dx + 1) * pyramid.TILE_SIZE] = block
            write_tile(surface, zoom, x, y, pyramid.downsample_mask(stacked))
            written += 1
    print(f"z{zoom}: {written} written, {time.time() - started:.0f} s",
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

    written = {pyramid.MAX_ZOOM: build_native(bounds, limit=limit)}
    if not limit:
        for zoom in range(pyramid.MAX_ZOOM - 1, pyramid.MIN_ZOOM - 1, -1):
            written[zoom] = build_overview(bounds, zoom)

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
