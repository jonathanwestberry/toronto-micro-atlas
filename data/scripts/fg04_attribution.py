"""Trace the obstruction that controls one shaded point's solar horizon.

This is a feasibility primitive, not a citywide delivery layer. It follows the
same rounded offsets and ray rise as ``fg04_shadow.cast_shadow`` so a positive
result means the existing model also marks that point shaded. The returned
cell has the greatest apparent altitude from the selected point. That is the
obstruction that controls when direct sun clears the local horizon.
"""

from dataclasses import dataclass
import math

import numpy as np

from fg04_shadow import HORIZON_DEG


@dataclass(frozen=True)
class Caster:
    row: int
    column: int
    distance_m: float
    obstruction_height_m: float
    apparent_altitude_deg: float


def trace_caster(surface: np.ndarray,
                 row: int,
                 column: int,
                 altitude: float,
                 azimuth: float,
                 resolution: float,
                 max_distance: float) -> Caster | None:
    """Return the skyline obstruction for one point, or ``None`` if sunlit.

    An altitude at or below the model horizon deliberately has no caster. The
    shade raster marks that frame everywhere by construction, without testing
    the surface, so naming a building or canopy there would invent evidence.
    """
    values = np.asarray(surface)
    if values.ndim != 2:
        raise ValueError("surface must be a two-dimensional array")
    if not isinstance(row, (int, np.integer)) \
            or not isinstance(column, (int, np.integer)):
        raise ValueError("row and column must be integers")
    height, width = values.shape
    if not (0 <= row < height and 0 <= column < width):
        raise ValueError("point is outside the surface")
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError("resolution must be positive")
    if not math.isfinite(max_distance) or max_distance <= 0:
        raise ValueError("maximum distance must be positive")
    if not math.isfinite(altitude) or not math.isfinite(azimuth):
        raise ValueError("solar position must be finite")

    if altitude <= HORIZON_DEG:
        return None

    target_height = float(values[row, column])
    if not math.isfinite(target_height):
        return None

    azimuth_rad = math.radians(azimuth)
    step_x = math.sin(azimuth_rad)
    step_y = -math.cos(azimuth_rad)
    sun_slope = math.tan(math.radians(altitude))
    best_slope = sun_slope
    best = None

    for step in range(1, int(max_distance / resolution) + 1):
        offset_x = int(round(step * step_x))
        offset_y = int(round(step * step_y))
        source_row = row + offset_y
        source_column = column + offset_x
        if not (0 <= source_row < height and 0 <= source_column < width):
            break

        distance = step * resolution
        obstruction_height = float(values[source_row, source_column])
        if not math.isfinite(obstruction_height):
            continue
        apparent_slope = (obstruction_height - target_height) / distance
        if apparent_slope <= best_slope:
            continue
        best_slope = apparent_slope
        best = Caster(
            row=source_row,
            column=source_column,
            distance_m=float(distance),
            obstruction_height_m=obstruction_height,
            apparent_altitude_deg=math.degrees(math.atan(apparent_slope)),
        )

    return best
