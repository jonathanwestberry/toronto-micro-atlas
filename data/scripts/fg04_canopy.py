"""Raise leaf-off canopy to a leaf-on equivalent.

Every lidar flight ever made over Toronto is spring: GTA 2014 in April-May,
GTA 2015 in April, GTA 2023 in April-May. Building shade is therefore
measured correctly and tree shade is not, which biases every neighbourhood
comparison in the same direction. This module is the correction, and the
guide reports corrected and uncorrected figures side by side.
"""

import numpy as np
from scipy.ndimage import uniform_filter


def correct_leaf_off(normalised: np.ndarray,
                     canopy_mask: np.ndarray,
                     bare_threshold: float = 3.0,
                     default_height: float = 8.0,
                     window: int = 51) -> np.ndarray:
    """Return a surface with bare canopy raised to local crown height.

    Only pixels inside `canopy_mask` that stand below `bare_threshold` are
    changed. Their new height is the mean height of nearby canopy pixels that
    did return a crown, falling back to `default_height` where a whole
    neighbourhood is bare.
    """
    surface = normalised.astype("float32", copy=True)
    crowns = canopy_mask & (normalised >= bare_threshold)

    crown_heights = np.where(crowns, normalised, 0.0).astype("float32")
    crown_counts = crowns.astype("float32")
    summed = uniform_filter(crown_heights, size=window, mode="nearest")
    counted = uniform_filter(crown_counts, size=window, mode="nearest")

    with np.errstate(invalid="ignore", divide="ignore"):
        local = np.where(counted > 0, summed / np.maximum(counted, 1e-6),
                         default_height)
    local = np.where(np.isfinite(local) & (local > 0), local, default_height)

    bare = canopy_mask & (normalised < bare_threshold)
    surface[bare] = local[bare]
    return surface


def correction_report(before: np.ndarray,
                      after: np.ndarray,
                      canopy_mask: np.ndarray) -> dict:
    raised = after > before
    rise = (after - before)[raised]
    return {
        "canopy_pixels": int(canopy_mask.sum()),
        "raised_pixels": int(raised.sum()),
        "mean_rise_m": float(rise.mean()) if rise.size else 0.0,
        "max_rise_m": float(rise.max()) if rise.size else 0.0,
    }
