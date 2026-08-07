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

    R  shaded-hours count, 0 to 15
    G  mask bits 8 to 14, the top bit unused
    B  mask bits 0 to 7

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

**Why the count is in RED, which looks arbitrary and is not.** MapLibre reads
these as a `raster-dem` source, whose default "mapbox" encoding computes

    value = R*6553.6 + G*25.6 + B*0.1 - 10000

The mask in G and B can contribute at most 255*25.6 + 255*0.1 = 6553.5, which
is just under R's step of 6553.6. So every count owns a band of `value` that
no other count can reach, and a `color-relief` layer can colour by count with
the mask riding along untouched in the same pixel.

The obvious alternative was `encoding: "custom"` with blueFactor 1, which the
style spec documents and the style validator accepts. It does not work:
MapLibre 5.24 sends `encoding` to the tile-decoding worker and does not send
`redFactor`, `greenFactor`, `blueFactor` or `baseShift` with it, so a custom
source decodes with the factors undefined and reads as garbage. Verified in a
browser, not assumed. Riding the default encoding needs no such feature.

R is derived from G and B. It is redundant on purpose, and
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

# Bump this whenever the tiles change. It is part of the URL, so a rebuild
# lands on new paths and the old ones simply stop being asked for.
#
# Tiles are served with `immutable, max-age=1 year`, which is right for a tile
# whose coordinates and modelled date fully determine it, and which means
# overwriting a key does NOT reach readers: Cloudflare keeps serving the
# cached copy for a year. That is not a caching bug to work around with a
# purge, it is what immutable means. The version segment is the fix, and a
# purge is only the rescue when someone forgets to bump it.
TILE_VERSION = "v3"
TILE_BASE_URL = f"https://tiles.torontomicroatlas.com/fg04/{TILE_VERSION}"
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


def encode_tile(bits: np.ndarray, count: np.ndarray = None) -> np.ndarray:
    """One surface as (height, width, 3) uint8. Count in red, mask in G and B.

    Read back by an ordinary `raster-dem` source on its default encoding, so
    a `color-relief` layer can apply the guide's ramp with no drawing code of
    our own and no reliance on the custom-encoding path, which MapLibre 5.24
    validates but never wires to its decoder.
    """
    check_bits(bits)
    bits = np.asarray(bits, dtype=np.uint16)
    if count is None:
        count = shaded_hours(bits)
    count = np.asarray(count, dtype=np.uint8)
    if count.shape != bits.shape:
        raise ValueError(
            f"count {count.shape} does not match the mask {bits.shape}")
    if int(count.max(initial=0)) > MAX_BIT + 1:
        raise ValueError(
            f"a count of {int(count.max())} is more than the "
            f"{MAX_BIT + 1} frames that were modelled")
    pixels = np.zeros(bits.shape + (CHANNELS,), dtype=np.uint8)
    pixels[:, :, 0] = count
    pixels[:, :, 1] = ((bits >> 8) & 0xFF).astype(np.uint8)
    pixels[:, :, 2] = (bits & 0xFF).astype(np.uint8)
    return pixels


def decode_tile(pixels: np.ndarray, verify: bool = False) -> np.ndarray:
    """One surface back to a uint16 mask.

    With `verify`, refuse a tile whose count channel disagrees with its
    mask. The count is redundant by design, and redundancy that is never
    checked is just two chances to be wrong.
    """
    pixels = np.asarray(pixels)
    bits = (pixels[:, :, 2].astype(np.uint16)
            | (pixels[:, :, 1].astype(np.uint16) << 8))
    if verify and not np.array_equal(pixels[:, :, 0], shaded_hours(bits)):
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


def downsample_mask(bits: np.ndarray, ground: np.ndarray = None) -> np.ndarray:
    """Halve a bitmask by voting on every hour separately.

    Picking one child pixel of four is not wrong so much as arbitrary: at
    z12 one sampled pixel would speak for 361. A parent bit is set when at
    least half its four children carry it, so "shaded at 13:00" keeps
    meaning "most of this ground was shaded at 13:00" all the way up the
    pyramid.

    A tie is shaded. It has to go somewhere, and either choice biases: ties
    up thickens shade at every level, ties down thins it. Measured over four
    levels, ties-up walks the mean count from 3.50 at z16 to 4.89 at z12, a
    40% inflation, which is why the count channel is NOT the population count
    of this at overview zooms. See `downsample_count`.
    """
    bits = np.asarray(bits, dtype=np.uint16)
    height, width = bits.shape
    if height % 2 or width % 2:
        raise ValueError(f"cannot halve a {height}x{width} tile")
    blocks = bits.reshape(height // 2, 2, width // 2, 2)

    # Only ground children get a vote. Without this a parent with one ground
    # child and three roofs could never reach two votes, so real shade would
    # vanish wherever ground is sparse.
    if ground is None:
        ground = bits > 0
    voters = np.asarray(ground, dtype=bool).reshape(
        height // 2, 2, width // 2, 2)
    count = voters.sum(axis=(1, 3))
    # Matches `downsample_count`: a parent is ground only when at least half
    # its children are, so the two channels agree about where ground is.
    count = np.where(count >= 2, count, 0)
    needed = np.maximum((count + 1) // 2, 1)

    parent = np.zeros((height // 2, width // 2), dtype=np.uint16)
    for position in range(MAX_BIT + 1):
        votes = (((blocks >> position) & 1) & voters).sum(axis=(1, 3))
        parent |= ((votes >= needed) & (count > 0)).astype(np.uint16) << position
    return parent


def tile_url_template(surface: str, base_url: str = None) -> str:
    if surface not in SURFACES:
        raise ValueError(f"unknown surface {surface!r}, expected {SURFACES}")
    base = TILE_BASE_URL if base_url is None else base_url.rstrip("/")
    return f"{base}/{surface}/{{z}}/{{x}}/{{y}}.{TILE_FORMAT}"


def tile_url_templates(base_url: str = None) -> dict:
    return {surface: tile_url_template(surface, base_url)
            for surface in SURFACES}


# MapLibre's default "mapbox" DEM unpack, which these tiles are built to ride.
# Not configuration: these are the constants MapLibre compiles in, restated
# here so the encoder and the map agree and a test can prove they do.
DEM_UNPACK = {
    "encoding": "mapbox",
    "redFactor": 6553.6,
    "greenFactor": 25.6,
    "blueFactor": 0.1,
    "baseShift": 10000.0,
}


def dem_value(count: int) -> float:
    """The lowest `["elevation"]` MapLibre reports for a given count.

    The mask in green and blue adds up to 6553.5 on top of this, which is
    less than one step of red, so [dem_value(c), dem_value(c + 1)) contains
    every pixel whose count is c and no pixel whose count is not.
    """
    return count * DEM_UNPACK["redFactor"] - DEM_UNPACK["baseShift"]


def dem_unpack(red: int, green: int, blue: int) -> float:
    """What MapLibre computes for one pixel. The same arithmetic, in Python."""
    return (red * DEM_UNPACK["redFactor"]
            + green * DEM_UNPACK["greenFactor"]
            + blue * DEM_UNPACK["blueFactor"]
            - DEM_UNPACK["baseShift"])


def downsample_count(counts: np.ndarray) -> np.ndarray:
    """Halve a count field by averaging, which is the unbiased aggregate.

    The count cannot be the population count of `downsample_mask` above
    overview zooms. No per-bit vote preserves the mean of the children's
    counts: ties have to break somewhere, and whichever way they break the
    error compounds at every level. Measured on this pyramid, majority vote
    with ties up drifts the mean from 3.50 at z16 to 4.89 at z12.

    That drift is not cosmetic. The count is the layer the reader sees, and a
    zoomed-out map reading 40% shadier than the guide's own figures is the map
    contradicting the prose.

    So the two channels answer two questions above z16. The mask says "was
    most of this ground shaded at hour n", which is the best a bit can do.
    The count says "how many frames shaded this ground on average", which is
    what the ramp is showing. At the native zoom they are the same number,
    and `decode_tile(..., verify=True)` checks it there.
    """
    counts = np.asarray(counts, dtype=np.uint16)
    height, width = counts.shape
    if height % 2 or width % 2:
        raise ValueError(f"cannot halve a {height}x{width} tile")
    blocks = counts.reshape(height // 2, 2, width // 2, 2)

    # Zero is not a count, it is "not ground". Averaging it in would drag a
    # parent toward zero in proportion to how much roof and crown its
    # children covered, which would draw a darker city wherever there are
    # fewer buildings. Average over the ground children only.
    #
    # But a parent is only ground at all when at least half its children are.
    # Letting one ground child of four speak for the whole parent is what
    # made the mean climb from 5.99 at z16 to 8.26 at z12: the places with
    # the least ground are the tower districts, which are also the shadiest,
    # so they gained weight at every level and dragged the whole city dark.
    ground = (blocks > 0)
    covered = ground.sum(axis=(1, 3))
    enough = covered >= 2
    total = np.where(ground, blocks, 0).sum(axis=(1, 3))

    # Round half to even. Rounding half UP looks like the innocent choice and
    # is not: it adds a quarter of a frame per level in expectation, which
    # over the four levels from z16 to z12 is more than a whole frame. Ties
    # to even cancel instead of accumulating.
    with np.errstate(invalid="ignore", divide="ignore"):
        averaged = np.rint(np.where(enough, total / np.maximum(covered, 1), 0))
    return np.where(enough, averaged, 0).astype(np.uint8)


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
        "tileVersion": TILE_VERSION,
        "tileUrlTemplates": tile_url_templates(base_url),
        "localTileUrlTemplates": tile_url_templates(LOCAL_TILE_BASE_URL),
        "demUnpack": dict(DEM_UNPACK),
        "countChannel": "red",
        "countIsPopulationCountAtNativeZoomOnly": True,
        "countAggregation": ("mean of the four children, rounded ties to even. "
                             "The mask aggregates by majority vote per bit, "
                             "which cannot preserve the mean count, so above "
                             "the native zoom the count channel is the "
                             "unbiased average and the mask is the best "
                             "per-bit answer."),
        "maskChannels": {"high": "green", "low": "blue"},
        # 0 to 16 inclusive: a floor for every count from 0 to 15, plus the
        # edge above the top band so the last band has somewhere to stop.
        "countBandStarts": {str(count): dem_value(count)
                            for count in range(MAX_BIT + 3)},
        "layout": ("One square image per surface per tile coordinate, at "
                   "/<surface>/{z}/{x}/{y}. R is the shaded-hours count, G is "
                   "mask bits 8 to 14 and B is mask bits 0 to 7. Read as a "
                   "raster-dem source on the default mapbox encoding, the "
                   "count owns a band of the unpacked value that the mask "
                   "cannot reach. Nothing is in alpha, because canvas rounds "
                   "alpha on read."),
        "surfaces": list(SURFACES),
        "surfaceLabels": dict(SURFACE_LABELS),
        "hourBits": {str(hour): bit for hour, bit in HOUR_BITS.items()},
        "maxBit": MAX_BIT,
        "firstHour": FIRST_HOUR,
        "lastHour": LAST_HOUR,
        "dawnHour": DAWN_HOUR,
        "dawnNote": ("The 06:00 frame sits at 0.38° above the horizon "
                     "and is shaded everywhere by construction, so every "
                     "pixel scores at least one shaded hour. Read the count "
                     "as frames of the modelled day, not as hours of shade."),
        "tilesWritten": tiles_written,
        "tilesProjected": projected["total"],
        "tilesProjectedByZoom": {str(zoom): projected[zoom]
                                 for zoom in range(MIN_ZOOM, MAX_ZOOM + 1)},
        "surfaceOrder": list(SURFACES),
    }
