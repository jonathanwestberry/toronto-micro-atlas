"""The shade tile encoding: one raster, a bitmask per pixel, two surfaces.

Phase 3 puts an hour slider on this map. Dragging it has to be a bit test
against data already in the browser, never a fetch, because a fetch per hour
turns a slider into fifteen network round trips and the argument this guide
makes lives in what happens *between* hours. So a tile carries every hour at
once, packed into bits, and the client reads the hour it needs.

**Layout.** Fifteen bits on two surfaces is thirty bits and RGB carries
twenty-four, so the two surfaces cannot share a pixel. They get a tile each,
at the same coordinates under different prefixes, which is what "separately
addressable" should have meant all along.

    R  mask bits 0 to 7
    G  mask bits 8 to 14, the top bit unused
    B  shaded-hours count, 0 to 15

An earlier revision stacked the two surfaces into one 256 by 512 image to
halve the file count, back when the tiles were going to be part of the
Cloudflare Pages deployment and 20,000 files was the binding limit. R2 has
no such limit, and the stacked tile was not square, which put it outside
what a `raster-dem` source can read. Two square tiles let MapLibre colourise
the count with a `color-relief` layer and an ordinary style expression,
instead of a hand-written WebGL layer that would have to re-implement tile
loading to do the same job.

Nothing goes in an alpha channel and there is no alpha channel to put it in.
Canvas stores pixels premultiplied and unpremultiplies them on read, so a
byte parked in alpha comes back rounded, and comes back destroyed wherever
alpha is zero. That failure looks like a rendering bug, not a data bug, and
costs a week.

B is derived from R and G. It is redundant on purpose: the count is what the
reader sees first, and a channel read beats a population count in a shader.
`decode_tile(..., verify=True)` refuses a tile whose count and mask disagree,
so the redundancy cannot rot into a contradiction.

**Both surfaces, always.** Every lidar flight over Toronto is leaf-off, and
the leaf-on correction reverses which neighbourhoods are shadiest. A reader
who can see the corrected surface must be able to see the measured one. That
rule governs the map, not only the prose, which is why a tile is not
considered complete with one half of it.

This guide maps shade. It does not map temperature, and nothing here may be
named or described as coolness.
"""

import math
import os

import numpy as np

from fg04_solar import FIRST_HOUR, LAST_HOUR, MODEL_DATE, TZ

# Bit position per clock hour, in the order `fg04_solar.hourly_frames` packs
# them: 06:00 is bit 0 and 20:00 is bit 14.
HOUR_BITS = {hour: hour - FIRST_HOUR
             for hour in range(FIRST_HOUR, LAST_HOUR + 1)}
MAX_BIT = LAST_HOUR - FIRST_HOUR
ALL_HOURS = (1 << (MAX_BIT + 1)) - 1        # 0x7FFF, bits 0 to 14

# 06:00 sits at 0.38 degrees above the horizon, at or below the model's
# cutoff, so `cast_shadow` returns an all-true mask for it without reading
# the surface. Every pixel in Toronto therefore scores at least one shaded
# hour by construction, and a shaded-hours count is never fifteen equal
# hours.
DAWN_HOUR = FIRST_HOUR

# The measured leaf-off surface first, the leaf-on corrected one second.
# These names are the pipeline's throughout, including `32_fg04_stats.py`.
SURFACES = ("raw", "corrected")

# Labelled in words, never by colour alone. Mauve and Plum sit 2.11 apart in
# contrast, which is not enough to carry which surface a reader is looking at.
SURFACE_LABELS = {
    "raw": "Measured, leaf-off",
    "corrected": "Leaf-on corrected",
}

CHANNELS = 3

# Delivery. Cloudflare Pages refuses a deployment over 20,000 files or a file
# over 25 MiB. Neither is an npm limit, so neither fails in CI: a pyramid that
# breaks the deploy passes every test in the repo and then dies at the edge.
CLOUDFLARE_FILE_LIMIT = 20_000
CLOUDFLARE_MAX_FILE_BYTES = 25 * 1024 * 1024

TILE_SIZE = 256
MIN_ZOOM = 12
# z16 resolves at 1.73 m/px, which matches the 2 m grid. z17 alone is 29,700
# tiles over the lidar rectangle and breaks the deployment on its own. If a
# later phase wants more zoom the answer is R2 or a split PMTiles archive,
# not more files.
MAX_ZOOM = 16

FLIGHT_SEASON = "April to May 2023"
GRID_RESOLUTION_M = 2.0

# Lossless WebP, measured against PNG on 120 real z16 tiles: the whole pyramid
# is 323 MB instead of 833 MB, 39% of the size, for the same bytes back out.
# Dropping the mask and shipping only the count would reach 181 MB, but that
# throws away the Phase 3 slider to save 142 MB, which is not a trade worth
# making.
TILE_FORMAT = "webp"
TILE_LOSSLESS = True

# Where the tiles are served from. Cloudflare Pages allows 20,000 files per
# deployment, and this one pyramid is 9,555 of them, so putting it in the
# deployment spends half the atlas's lifetime budget on one guide and adds
# 323 MB to git history on every rebuild. R2 has neither limit, keeps the
# deployment at its current ~450 files however many map guides ship, and
# costs nothing to serve behind Cloudflare's CDN.
HOSTING = "r2"
R2_BUCKET = "toronto-micro-atlas-tiles"
TILE_BASE_URL = f"https://tiles.torontomicroatlas.com/fg04"
# Local dev serves the same tree out of `public/`, so the map works before
# anything is uploaded.
LOCAL_TILE_BASE_URL = "/data/fg04/tiles"


class FileBudgetError(RuntimeError):
    """Raised before anything is written, never after."""


def hour_bit(hour: int) -> int:
    """The bit position for a clock hour, or ValueError outside the day."""
    try:
        return HOUR_BITS[int(hour)]
    except KeyError:
        raise ValueError(
            f"{hour}:00 is outside the modelled day, "
            f"{FIRST_HOUR}:00 to {LAST_HOUR}:00") from None


def hour_mask(bits: np.ndarray, hour: int) -> np.ndarray:
    """True where the sun was blocked at `hour`. One bit test, no fetch."""
    return ((bits >> hour_bit(hour)) & 1).astype(bool)


def shaded_hours(bits: np.ndarray) -> np.ndarray:
    """How many of the fifteen modelled frames were shaded, per pixel.

    Frames of the modelled day, not hours of usable shade: the 06:00 frame
    is shaded everywhere, so the floor is one rather than zero.
    """
    counts = np.zeros(bits.shape, dtype=np.uint8)
    for position in range(MAX_BIT + 1):
        counts += ((bits >> position) & 1).astype(np.uint8)
    return counts


def check_bits(bits: np.ndarray) -> np.ndarray:
    """Refuse a mask with anything above bit 14 set.

    The citywide rasters satisfy this and the pyramid may not break it. A
    sixteenth bit would be a frame the model never computed, and it would
    read downstream as an extra shaded hour rather than as corruption.
    """
    highest = int(np.asarray(bits).max()) if np.asarray(bits).size else 0
    if highest > ALL_HOURS:
        raise ValueError(
            f"bit above position {MAX_BIT} is set: saw {highest:#06x}, "
            f"the modelled day is {ALL_HOURS:#06x}")
    return bits


def dawn_is_universal(bits: np.ndarray, ground: np.ndarray) -> bool:
    """True when every ground pixel carries the 06:00 bit.

    It should be impossible for this to be False. It is checked anyway,
    because if it ever goes False the shaded-hours count has quietly changed
    meaning and every figure in the guide moves with it.
    """
    return bool(hour_mask(bits, DAWN_HOUR)[ground].all())


def encode_tile(bits: np.ndarray) -> np.ndarray:
    """One surface as (height, width, 3) uint8.

    Read back by a `raster-dem` source with `encoding: "custom"`,
    `blueFactor: 1` and every other factor zero, which makes MapLibre's
    elevation value the shaded-hours count and lets a `color-relief` layer
    apply the guide's ramp with no custom drawing code at all.
    """
    check_bits(bits)
    bits = np.asarray(bits, dtype=np.uint16)
    pixels = np.zeros(bits.shape + (CHANNELS,), dtype=np.uint8)
    pixels[:, :, 0] = (bits & 0xFF).astype(np.uint8)
    pixels[:, :, 1] = ((bits >> 8) & 0xFF).astype(np.uint8)
    pixels[:, :, 2] = shaded_hours(bits)
    return pixels


def decode_tile(pixels: np.ndarray, verify: bool = False) -> np.ndarray:
    """One surface back to a uint16 mask.

    With `verify`, refuse a tile whose count channel disagrees with its
    mask. The count is redundant by design, and redundancy that is never
    checked is just two chances to be wrong.
    """
    pixels = np.asarray(pixels)
    bits = (pixels[:, :, 0].astype(np.uint16)
            | (pixels[:, :, 1].astype(np.uint16) << 8))
    if verify and not np.array_equal(pixels[:, :, 2], shaded_hours(bits)):
        raise ValueError(
            "the count channel disagrees with its mask; the tile is corrupt "
            "or was written by two code paths")
    return bits


def tile_x(longitude: float, zoom: int) -> int:
    return int((longitude + 180.0) / 360.0 * (1 << zoom))


def tile_y(latitude: float, zoom: int) -> int:
    radians = math.radians(latitude)
    return int((1.0 - math.asinh(math.tan(radians)) / math.pi)
               / 2.0 * (1 << zoom))


def tile_range(bounds, zoom: int):
    """(x0, y0, x1, y1) inclusive, for WGS84 bounds at `zoom`."""
    west, south, east, north = bounds
    return (tile_x(west, zoom), tile_y(north, zoom),
            tile_x(east, zoom), tile_y(south, zoom))


def tiles_for_bounds(bounds, zoom: int):
    x0, y0, x1, y1 = tile_range(bounds, zoom)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


def tile_count(bounds, zoom: int) -> int:
    x0, y0, x1, y1 = tile_range(bounds, zoom)
    return (x1 - x0 + 1) * (y1 - y0 + 1)


def project_file_count(bounds, zooms=None) -> dict:
    """Files per zoom and in total, before a single one is written.

    One file per surface per coordinate, so twice the tile coordinates. The
    stacked layout that fitted both surfaces in one file is gone: it was not
    square, and a `raster-dem` source cannot read a tile that is not square.
    """
    zooms = range(MIN_ZOOM, MAX_ZOOM + 1) if zooms is None else zooms
    counts = {zoom: tile_count(bounds, zoom) * len(SURFACES) for zoom in zooms}
    counts["total"] = sum(counts[zoom] for zoom in zooms)
    counts["coordinates"] = sum(tile_count(bounds, zoom) for zoom in zooms)
    return counts


def check_file_budget(projected: int, existing: int,
                      ceiling: int = CLOUDFLARE_FILE_LIMIT) -> None:
    """Refuse a pyramid that would break the deployment. Before writing.

    CI cannot catch this. The limit belongs to Cloudflare, not to npm, so the
    failure mode without this gate is a green build and a dead deploy.
    """
    total = projected + existing
    if total > ceiling:
        raise FileBudgetError(
            f"{total:,} files would be deployed, {projected:,} of them new, "
            f"against Cloudflare's limit of {ceiling:,}. Cutting a zoom level "
            f"is the cheap fix. More zoom than z{MAX_ZOOM} needs R2 or a "
            f"split PMTiles archive, not more files.")


def check_file_sizes(paths, limit: int = CLOUDFLARE_MAX_FILE_BYTES) -> None:
    """Refuse any single file Cloudflare would reject."""
    for path in paths:
        size = os.path.getsize(path)
        if size > limit:
            raise FileBudgetError(
                f"{path} is {size / 1024 / 1024:.1f} MiB, over Cloudflare's "
                f"{limit / 1024 / 1024:.0f} MiB per-file limit")


def downsample_mask(bits: np.ndarray) -> np.ndarray:
    """Halve a bitmask by voting on every hour separately.

    Picking one child pixel of four is not wrong so much as arbitrary: at
    z12 one sampled pixel would speak for 361. A parent bit is set when at
    least half its four children carry it, so "shaded at 13:00" keeps
    meaning "most of this ground was shaded at 13:00" all the way up the
    pyramid.

    A tie is shaded. It has to go somewhere, and the alternative silently
    thins shade at every level, which would walk the count layer downward
    as the reader zooms out.
    """
    bits = np.asarray(bits, dtype=np.uint16)
    height, width = bits.shape
    if height % 2 or width % 2:
        raise ValueError(f"cannot halve a {height}x{width} tile")
    blocks = bits.reshape(height // 2, 2, width // 2, 2)

    parent = np.zeros((height // 2, width // 2), dtype=np.uint16)
    for position in range(MAX_BIT + 1):
        votes = ((blocks >> position) & 1).sum(axis=(1, 3))
        parent |= (votes >= 2).astype(np.uint16) << position
    return parent


def tile_url_template(surface: str, base_url: str = None) -> str:
    if surface not in SURFACES:
        raise ValueError(f"unknown surface {surface!r}, expected {SURFACES}")
    base = TILE_BASE_URL if base_url is None else base_url.rstrip("/")
    return f"{base}/{surface}/{{z}}/{{x}}/{{y}}.{TILE_FORMAT}"


def tile_url_templates(base_url: str = None) -> dict:
    return {surface: tile_url_template(surface, base_url)
            for surface in SURFACES}


# MapLibre reads the count straight out of the blue channel. A `raster-dem`
# source with this encoding makes the style expression `["elevation"]` equal
# to the shaded-hours count, which a `color-relief` layer then runs through
# the guide's own ramp. No custom drawing code, and the ramp stays in CSS
# where it was decided.
DEM_ENCODING = {
    "encoding": "custom",
    "redFactor": 0,
    "greenFactor": 0,
    "blueFactor": 1,
    "baseShift": 0,
}


def manifest(bounds, tiles_written: int, projected: dict,
             base_url: str = None) -> dict:
    """The one description of the tiles that the legend and layers both read.

    fg03 follows the same rule. A legend that carries its own copy of the
    modelled date is a legend that will one day disagree with the data it
    labels.
    """
    return {
        "schemaVersion": 1,
        "modelledDate": MODEL_DATE,
        "timezone": TZ,
        "gridResolutionM": GRID_RESOLUTION_M,
        "flightSeason": FLIGHT_SEASON,
        "bounds": list(bounds),
        "minZoom": MIN_ZOOM,
        "maxZoom": MAX_ZOOM,
        "nativeZoom": MAX_ZOOM,
        "tileSize": TILE_SIZE,
        "channels": CHANNELS,
        "format": TILE_FORMAT,
        "lossless": TILE_LOSSLESS,
        "hosting": HOSTING,
        "tileUrlTemplates": tile_url_templates(base_url),
        "localTileUrlTemplates": tile_url_templates(LOCAL_TILE_BASE_URL),
        "demEncoding": dict(DEM_ENCODING),
        "layout": ("One square image per surface per tile coordinate, at "
                   "/<surface>/{z}/{x}/{y}. R is mask bits 0 to 7, G is bits "
                   "8 to 14, B is the shaded-hours count. Nothing is in "
                   "alpha, because canvas rounds alpha on read."),
        "surfaces": list(SURFACES),
        "surfaceLabels": dict(SURFACE_LABELS),
        "hourBits": {str(hour): bit for hour, bit in HOUR_BITS.items()},
        "maxBit": MAX_BIT,
        "firstHour": FIRST_HOUR,
        "lastHour": LAST_HOUR,
        "dawnHour": DAWN_HOUR,
        "dawnNote": ("The 06:00 frame sits at 0.38 degrees above the horizon "
                     "and is shaded everywhere by construction, so every "
                     "pixel scores at least one shaded hour. Read the count "
                     "as frames of the modelled day, not as hours of shade."),
        "tilesWritten": tiles_written,
        "tilesProjected": projected["total"],
        "tilesProjectedByZoom": {str(zoom): projected[zoom]
                                 for zoom in range(MIN_ZOOM, MAX_ZOOM + 1)},
        "surfaceOrder": list(SURFACES),
    }
