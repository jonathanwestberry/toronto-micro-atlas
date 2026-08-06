"""Raise leaf-off canopy to a leaf-on equivalent.

Every lidar flight ever made over Toronto is spring: GTA 2014 in April-May,
GTA 2015 in April, GTA 2023 in April-May. Building shade is therefore
measured correctly and tree shade is not, which biases every neighbourhood
comparison in the same direction. This module is the correction, and the
guide reports corrected and uncorrected figures side by side.
"""

import numpy as np
from rasterio.features import rasterize
from scipy.ndimage import uniform_filter

# Class codes in Toronto's 2018 Tree Canopy Study land cover. The full set is
# 1 tree, 2 grass, 3 bare, 4 water, 5 building, 6 road, 7 other, 8 shrub.
# Shrub is deliberately not canopy: the guide's argument is about tree cover,
# and a leaf-off shrub casts little either way.
TREE_CODE = 1
BUILDING_CODE = 5


def class_mask(cover, codes, out_shape, transform, crs) -> np.ndarray:
    """Burn the requested land cover classes onto a raster grid.

    `cover` is the land cover polygons, reprojected here if it does not
    already sit in `crs`. The 2018 study is published in EPSG:2952 while the
    lidar is EPSG:6660, so this reprojection is the normal case rather than
    the exception.
    """
    wanted = cover[cover["gridcode"].isin(set(codes))]
    if crs is not None and wanted.crs is not None and wanted.crs != crs:
        wanted = wanted.to_crs(crs)
    if wanted.empty:
        return np.zeros(out_shape, dtype=bool)
    burned = rasterize(
        ((geom, 1) for geom in wanted.geometry),
        out_shape=out_shape,
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=False,
    )
    return burned.astype(bool)


def correct_leaf_off(normalised: np.ndarray,
                     canopy_mask: np.ndarray,
                     bare_threshold: float = 3.0,
                     default_height: float = 8.0,
                     window: int = 51,
                     with_detail: bool = False):
    """Return a surface with bare canopy raised to local crown height.

    Only pixels inside `canopy_mask` that stand below `bare_threshold` are
    changed. Their new height is the mean height of nearby canopy pixels that
    did return a crown, falling back to `default_height` where a whole
    neighbourhood is bare.

    With `with_detail`, also return how many raised pixels took a height
    measured from a neighbouring crown and how many took the assumed
    default. The two are not equally trustworthy and the guide has to report
    the split rather than present all of it as a correction from data.
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
    has_crown = (counted > 0) & np.isfinite(local) & (local > 0)
    local = np.where(has_crown, local, default_height)

    bare = canopy_mask & (normalised < bare_threshold)
    surface[bare] = local[bare]
    if not with_detail:
        return surface
    detail = {
        "measured_pixels": int((bare & has_crown).sum()),
        "defaulted_pixels": int((bare & ~has_crown).sum()),
        "default_height_m": float(default_height),
        "bare_threshold_m": float(bare_threshold),
        "window_px": int(window),
    }
    return surface, detail


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
