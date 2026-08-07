"""The shade tile encoding: one raster, a bitmask per pixel, two surfaces.

Phase 3 puts an hour slider on this map. Dragging it has to be a bit test
against data already in the browser, never a fetch, because a fetch per hour
turns a slider into fifteen network round trips and the argument this guide
makes lives in what happens *between* hours. So a tile carries every hour at
once, packed into bits, and the client reads the hour it needs.

**Layout.** Fifteen bits on two surfaces is thirty bits, and RGB carries
twenty-four, so the two surfaces cannot share a pixel. They share an image
instead: the measured surface on top, the leaf-on corrected surface below,
each half the tile's own size.

    R  mask bits 0 to 7
    G  mask bits 8 to 14, the top bit unused
    B  shaded-hours count, 0 to 15

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

import numpy as np

from fg04_solar import FIRST_HOUR, LAST_HOUR

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

CHANNELS = 3


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


def encode_half(bits: np.ndarray) -> np.ndarray:
    """One surface as (height, width, 3) uint8."""
    check_bits(bits)
    bits = np.asarray(bits, dtype=np.uint16)
    pixels = np.zeros(bits.shape + (CHANNELS,), dtype=np.uint8)
    pixels[:, :, 0] = (bits & 0xFF).astype(np.uint8)
    pixels[:, :, 1] = ((bits >> 8) & 0xFF).astype(np.uint8)
    pixels[:, :, 2] = shaded_hours(bits)
    return pixels


def decode_half(pixels: np.ndarray) -> np.ndarray:
    """One surface back to a uint16 mask. The count channel is ignored."""
    pixels = np.asarray(pixels)
    return (pixels[:, :, 0].astype(np.uint16)
            | (pixels[:, :, 1].astype(np.uint16) << 8))


def encode_tile(raw: np.ndarray, corrected: np.ndarray) -> np.ndarray:
    """Both surfaces as one image, measured above corrected.

    Stacked rather than packed into four channels because the alternative
    puts payload in alpha, and alpha does not survive a canvas round trip.
    """
    raw = np.asarray(raw, dtype=np.uint16)
    corrected = np.asarray(corrected, dtype=np.uint16)
    if raw.shape != corrected.shape:
        raise ValueError(
            f"the two surfaces must be the same shape: "
            f"measured {raw.shape}, corrected {corrected.shape}")
    return np.concatenate([encode_half(raw), encode_half(corrected)], axis=0)


def decode_tile(pixels: np.ndarray, verify: bool = False) -> dict:
    """Both surfaces back, keyed by `SURFACES`.

    With `verify`, refuse a tile whose count channel disagrees with its
    mask. The count is redundant by design, and redundancy that is never
    checked is just two chances to be wrong.
    """
    pixels = np.asarray(pixels)
    height = pixels.shape[0]
    if height % 2:
        raise ValueError(
            f"a tile is two stacked surfaces, so its height must be even, "
            f"got {height}")
    half = height // 2
    decoded = {"raw": decode_half(pixels[:half]),
               "corrected": decode_half(pixels[half:])}
    if verify:
        for surface, rows in (("raw", slice(0, half)),
                              ("corrected", slice(half, height))):
            expected = shaded_hours(decoded[surface])
            if not np.array_equal(pixels[rows, :, 2], expected):
                raise ValueError(
                    f"the {surface} count channel disagrees with its mask; "
                    "the tile is corrupt or was written by two code paths")
    return decoded
