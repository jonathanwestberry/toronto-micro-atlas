"""Resample every source tile once, then window from the result.

The citywide build processes Toronto as overlapping windows, because a
537 m tower throws 2.5 km at 20:00 and an unbuffered window silently
truncates long shadows while still looking plausible. Each window is
therefore padded by a shadow margin, and adjacent padded windows cover the
same ground.

Calling `rasterio.merge` per window reads about 119 tiles per window per
surface, up to 194 on the downtown window. Across 24 windows and two
surfaces that is roughly 5,700 tile reads against 1,454 distinct tiles, so
every tile is decompressed about 3.9 times, each read inflating a 16 MB
float32 GeoTIFF and resampling 0.5 m to 2 m.

**Measured, because the Phase 2 plan's estimate was wrong.** The plan put
merge at about 1,000 of each window's 1,200 seconds. On the downtown window,
the worst in the city, merge is 14.1 s for both surfaces. The recorded 2 m
citywide run was 13,273.2 s over 24 windows, so a window averages 553 s and
merge is about 2.5% of it, not 83%. The bulk is `fg04_shadow.cast_shadow`,
which allocates a full-size array per sweep step.

This module is therefore a modest win rather than the headline one: one
window's surface read drops from 14.1 s to 1.9 s, against a one-time
85 s mosaic pass and 0.75 GB on disk, which is about 207 s off a 3.69 hour
run. It is kept because it is free at runtime, because it is now the only
path, and because reading a window is no longer quadratic in how much the
windows overlap.

The mosaic is tiled, so a window only decompresses the blocks it covers, and
the blocks are 2 m rather than 0.5 m, a sixteenth of the pixels.

Raising the window size instead would also cut the overlap, but peak memory
grows with the square of the window while the margin stays fixed, so it
trades one wall for another.

**The numbers must not move.** `build_mosaic` reproduces `rasterio.merge`'s
default first-wins, nearest-neighbour behaviour on the same snapped grid, and
`test_fg04_mosaic.py` asserts window-for-window equality against merge itself.
"""

import glob
import os

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window, from_bounds

# The tiles carry float32-extreme nodata: -3.4e38 on the DSM, +3.4e38 on the
# DTM. Those cannot survive arithmetic, so the mosaic stores an ordinary
# sentinel and validity is decided by range. Real Toronto elevations are 65
# to 450 m above CGVD2013, so anything outside a very generous window is a
# sentinel rather than ground.
FILL = -9999.0
MIN_REAL_M = -1000.0
MAX_REAL_M = 10000.0

# The CN Tower measures 537.0 m in this lidar. 600 m clears it with headroom
# while still catching lidar spikes.
MAX_HEIGHT_M = 600.0


def real(values: np.ndarray) -> np.ndarray:
    """True where a value is a plausible elevation rather than a sentinel."""
    return (values > MIN_REAL_M) & (values < MAX_REAL_M)


def snap(bounds, resolution):
    """Grow bounds outward to whole pixels so every window shares one grid."""
    left, bottom, right, top = bounds
    return (np.floor(left / resolution) * resolution,
            np.floor(bottom / resolution) * resolution,
            np.ceil(right / resolution) * resolution,
            np.ceil(top / resolution) * resolution)


def tile_index(folder, opener=rasterio.open):
    """[(path, bounds, crs)] for every tile in a folder.

    This is the one bounds pass. It opens each tile once and reads no pixels;
    `build_mosaic` then opens each tile once more and reads the pixels. Both
    passes are constant in the number of windows, which is the whole point.
    """
    index = []
    for path in sorted(glob.glob(os.path.join(folder, "*.tif"))):
        with opener(path) as src:
            index.append((path, tuple(src.bounds), src.crs))
    return index


def union_bounds(index):
    lefts = [b[0] for _, b, _ in index]
    bottoms = [b[1] for _, b, _ in index]
    rights = [b[2] for _, b, _ in index]
    tops = [b[3] for _, b, _ in index]
    return min(lefts), min(bottoms), max(rights), max(tops)


def intersecting(index, bounds):
    left, bottom, right, top = bounds
    return [p for p, (l, b, r, t), _ in index
            if l < right and r > left and b < top and t > bottom]


def grid(bounds, resolution):
    """The snapped output grid: (bounds, width, height, transform)."""
    left, bottom, right, top = snap(bounds, resolution)
    width = int(round((right - left) / resolution))
    height = int(round((top - bottom) / resolution))
    transform = rasterio.transform.from_origin(left, top, resolution, resolution)
    return (left, bottom, right, top), width, height, transform


def _aligned(window: Window) -> Window:
    """Round a float window the way rasterio.merge rounds one."""
    return Window(int(np.floor(window.col_off + 0.1)),
                  int(np.floor(window.row_off + 0.1)),
                  int(np.floor(window.width + 0.5)),
                  int(np.floor(window.height + 0.5)))


def _intersection(one, other):
    """The ground two boxes share, or None. Merge's `_intersect_bounds`."""
    left = max(one[0], other[0])
    bottom = max(one[1], other[1])
    right = min(one[2], other[2])
    top = min(one[3], other[3])
    if left >= right or bottom >= top:
        return None
    return left, bottom, right, top


def _overlaps(index):
    """Any two tiles covering the same ground, which first-wins would decide."""
    for position, (path, bounds, _) in enumerate(index):
        for other_path, other_bounds, _ in index[position + 1:]:
            if (bounds[0] < other_bounds[2] and bounds[2] > other_bounds[0]
                    and bounds[1] < other_bounds[3] and bounds[3] > other_bounds[1]):
                return path, other_path
    return None


def build_mosaic(index, bounds, resolution, path, opener=rasterio.open):
    """Write one mosaic covering `bounds`, reading every tile exactly once.

    Equivalent to `rasterio.merge(paths, bounds=snap(bounds), res=resolution,
    nodata=FILL)` written to disk: same snapped grid, same nearest-neighbour
    resampling, same rule that a source's own nodata is not copied.

    Overlapping sources are rejected rather than silently resolved. Merge's
    first-wins would depend on read order, and the Ontario 1 km tiling does
    not overlap, so an overlap here means the input is not what this pipeline
    assumes.
    """
    if not index:
        raise ValueError("no tiles to mosaic")
    clash = _overlaps(index)
    if clash is not None:
        raise ValueError(
            f"overlapping source tiles, which first-wins would have to "
            f"decide between: {os.path.basename(clash[0])} and "
            f"{os.path.basename(clash[1])}")

    (left, bottom, right, top), width, height, transform = grid(bounds, resolution)
    profile = dict(driver="GTiff", width=width, height=height, count=1,
                   dtype="float32", nodata=FILL, crs=index[0][2],
                   transform=transform, compress="deflate", predictor=3,
                   tiled=True, blockxsize=512, blockysize=512, BIGTIFF="YES")

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with rasterio.open(path, "w", **profile) as sink:
        sink.update_tags(fg04_tiles=str(len(index)),
                         fg04_resolution=repr(float(resolution)))
        for tile_path, tile_bounds, _ in index:
            # A tile can hang over the edge when only part of the city is
            # being mosaicked. Read the shared ground rather than the whole
            # tile, which is what merge does and what keeps the write inside
            # the raster.
            shared = _intersection(tile_bounds, (left, bottom, right, top))
            if shared is None:
                continue
            window = _aligned(from_bounds(*shared, transform))
            if window.width <= 0 or window.height <= 0:
                continue
            with opener(tile_path) as src:
                data = src.read(1, window=from_bounds(*shared, src.transform),
                                out_shape=(int(window.height),
                                           int(window.width)),
                                masked=True, resampling=Resampling.nearest)
            block = np.where(np.ma.getmaskarray(data), FILL,
                             np.ma.getdata(data)).astype("float32")
            sink.write(block, 1, window=window)
    return path


def mosaic_is_current(path, index, bounds, resolution, opener=rasterio.open):
    """True when the mosaic on disk is already the one that was asked for."""
    if not os.path.exists(path):
        return False
    (left, bottom, right, top), width, height, _ = grid(bounds, resolution)
    try:
        with opener(path) as src:
            tags = src.tags()
            return (src.width == width and src.height == height
                    and src.res == (resolution, resolution)
                    and tags.get("fg04_tiles") == str(len(index))
                    and tags.get("fg04_resolution") == repr(float(resolution)))
    except rasterio.errors.RasterioIOError:
        return False


def ensure_mosaic(index, bounds, resolution, path, opener=rasterio.open):
    """Build the mosaic unless the one on disk already matches the request."""
    if mosaic_is_current(path, index, bounds, resolution, opener=opener):
        return path
    return build_mosaic(index, bounds, resolution, path, opener=opener)


def read_window(path, bounds, resolution, opener=rasterio.open):
    """Read `bounds` off a mosaic on the shared grid.

    Returns the same array and transform `rasterio.merge` would have returned
    for those bounds. Ground outside the mosaic reads as FILL, which is what
    merge does with bounds beyond its sources.
    """
    (left, bottom, right, top), width, height, transform = grid(bounds, resolution)
    with opener(path) as src:
        if src.res != (resolution, resolution):
            raise ValueError(
                f"mosaic is {src.res[0]} m, window asked for {resolution} m")
        window = _aligned(from_bounds(left, bottom, right, top, src.transform))
        outside = (window.col_off < 0 or window.row_off < 0
                   or window.col_off + window.width > src.width
                   or window.row_off + window.height > src.height)
        array = src.read(1, window=window, boundless=outside, fill_value=FILL)
    return array.astype("float32", copy=False), transform


def normalised_window(dsm_path, dtm_path, bounds, resolution,
                      opener=rasterio.open):
    """DSM minus DTM over `bounds`, with nodata on either side knocked out.

    The same contract `31_build_shade.normalised` had against merge: height
    is zero and `valid` is False wherever either surface is missing, so a
    coverage gap cannot read as a building.
    """
    dsm, transform = read_window(dsm_path, bounds, resolution, opener=opener)
    dtm, _ = read_window(dtm_path, bounds, resolution, opener=opener)
    valid = real(dsm) & real(dtm)
    height = np.where(valid, dsm - dtm, 0.0).astype("float32")
    np.clip(height, 0.0, MAX_HEIGHT_M, out=height)
    return height, transform, valid
