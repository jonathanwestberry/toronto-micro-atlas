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
