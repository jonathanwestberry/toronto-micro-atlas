"""Summarise shade rasters into the numbers the pre-registration asks for.

The citywide rasters are around 946 million pixels, so nothing here loads a
whole surface. Shaded hours only take the values 0 to 15, so a per-zone
histogram over those 16 bins is accumulated block by block and every mean and
median is recovered from it exactly, without a second pass over the raster.

Two rules this module exists to enforce:

* An unsampled zone reports as not-a-number, never as zero. A street with no
  sidewalk pixels is a street nobody measured, not a street with no shade,
  and letting the two collapse would invent shade-poor roads.
* The shortage share is measured in kilometres, not in count of segments,
  so one long boulevard is not outvoted by a handful of short stubs.
"""

import numpy as np

FRAMES = 15                 # modelled daylight hours, bits 0 to 14
HOURS = FRAMES + 1          # histogram bins, 0 to 15 inclusive


def shaded_hours(bits: np.ndarray) -> np.ndarray:
    """Count set bits in positions 0 to 14, the modelled daylight hours.

    Bit 15 is deliberately ignored. Nothing should ever set it, and if
    something does it is a packing error rather than a sixteenth hour.
    """
    total = np.zeros(bits.shape, dtype=np.uint8)
    for position in range(FRAMES):
        total += ((bits >> position) & 1).astype(np.uint8)
    return total


def histogram(counts: np.ndarray, labels: np.ndarray, hours: np.ndarray,
              keep: np.ndarray, zones: int) -> None:
    """Accumulate counts[zone, hour] in place for the pixels in `keep`."""
    if not keep.any():
        return
    zone = labels[keep].astype(np.int64)
    hour = hours[keep].astype(np.int64)
    flat = np.bincount(zone * HOURS + hour, minlength=zones * HOURS)
    counts += flat[:zones * HOURS].reshape(zones, HOURS)


def mean_from_histogram(counts: np.ndarray) -> np.ndarray:
    values = np.arange(HOURS)
    total = counts.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = (counts * values).sum(axis=1) / total
    return np.where(total > 0, mean, np.nan)


def median_from_histogram(counts: np.ndarray) -> np.ndarray:
    """Exact median, cheap because the value space is only 0 to 15."""
    total = counts.sum(axis=1)
    cumulative = np.cumsum(counts, axis=1)
    median = np.full(counts.shape[0], np.nan)
    for zone in range(counts.shape[0]):
        if total[zone] == 0:
            continue
        position = np.searchsorted(cumulative[zone], total[zone] / 2.0)
        # An even count landing exactly on a bin edge sits between two bins,
        # which is what numpy's median would average.
        if (total[zone] % 2 == 0
                and position + 1 < HOURS
                and cumulative[zone][position] == total[zone] / 2.0):
            upper = position + 1
            while upper < HOURS and counts[zone][upper] == 0:
                upper += 1
            median[zone] = (position + upper) / 2.0 if upper < HOURS else position
        else:
            median[zone] = float(position)
    return median


def all_hours(frames: int) -> int:
    """The bitmask meaning "shaded in every frame this raster holds".

    The July raster holds fifteen frames and its constant is 0x7FFF. A
    raster built from a selected hour holds one, and reusing the July
    constant there would set fourteen bits the file never modelled, which
    the under-canopy override would then read back as shade.
    """
    if not 1 <= frames <= FRAMES:
        raise ValueError(f"{frames} frames is outside 1 to {FRAMES}")
    return (1 << frames) - 1


def bit_for_hour(frames, hour: int) -> int:
    """Which bit of a raster holds a given clock hour.

    A raster numbers its own frames from zero. The July raster starts at
    06:00, so 13:00 is bit 7, but a raster built from a selected hour starts
    wherever it starts. Asking the frames rather than assuming is what keeps
    the two readable by the same code.
    """
    for position, frame in enumerate(frames):
        if frame.clock.hour == hour:
            return position
    raise ValueError(f"no frame at {hour}:00 in this raster")


def block_swing(shaded_a: np.ndarray,
                shaded_b: np.ndarray,
                ground: np.ndarray,
                min_ground: float) -> float | None:
    """How much more ground is shaded in frame b than frame a.

    None when the block holds too little ground to be worth showing. A
    block that is mostly lake or mostly rooftop swings beautifully and
    shows a reader nothing, so ground is a floor rather than a tiebreak.
    """
    total = int(ground.sum())
    if total == 0 or total / ground.size < min_ground:
        return None
    before = int(shaded_a[ground].sum())
    after = int(shaded_b[ground].sum())
    return (after - before) / total


def frame_share(bits: np.ndarray,
                ground: np.ndarray,
                bit: int) -> tuple[int, int]:
    """(ground pixels, ground pixels shaded in this frame) for one block.

    July's published minimum, 10.73% raw and 19.70% corrected at 13:00, is
    this statistic. Chapter six's winter figure is the same one at January
    midday, which is what lets the two sit beside each other.
    """
    if not ground.any():
        return 0, 0
    lit = ((bits >> bit) & 1).astype(bool)
    return int(ground.sum()), int(lit[ground].sum())


def shadiest_among(means: np.ndarray,
                   eligible: np.ndarray,
                   lengths_m: np.ndarray | None = None,
                   minimum_length_m: float = 0.0) -> int | None:
    """Index of the shadiest eligible segment, or None if there is not one.

    The same unsampled rule the rest of this module keeps: a NaN mean is a
    street nobody measured, and it must not be allowed to win a superlative
    the guide intends to print. A caller may also require enough sampled
    centreline to keep a short tagging artefact from winning a citywide rank.
    """
    if lengths_m is not None:
        eligible = eligible & (lengths_m >= minimum_length_m)
    usable = eligible & ~np.isnan(means)
    if not usable.any():
        return None
    return int(np.nanargmax(np.where(usable, means, -np.inf)))


def shortage_share(medians: np.ndarray,
                   lengths_m: np.ndarray,
                   arterial: np.ndarray,
                   n: int) -> tuple[float, float, float]:
    """Return (share_percent, shade_poor_km, arterial_km).

    Only sampled arterial segments count, on both sides of the ratio. A
    segment nobody measured is neither shade-poor nor shade-rich, and
    dropping it from the numerator while keeping it in the denominator would
    quietly understate the shortage.
    """
    sampled = arterial & ~np.isnan(medians)
    total_km = lengths_m[sampled].sum() / 1000.0
    poor_km = lengths_m[sampled & (medians < n)].sum() / 1000.0
    share = (100.0 * poor_km / total_km) if total_km else 0.0
    return share, poor_km, total_km
