"""Cast shadows across a height surface.

The method is the standard shifted-plane sweep: step along the direction of
the sun, lowering a copy of the surface by the sun's rise over that distance,
and mark anything the lowered copy still stands above.

A 352 m tower throws 2.5 km at 20:00, which crosses two and a half of
Ontario's 1 km tiles. Processing tiles without a buffer truncates every long
shadow, and the output still looks plausible, so `required_buffer` exists to
make the caller state the buffer rather than discover the bug later.
"""

import math

import numpy as np

from fg04_solar import shadow_ratio

HORIZON_DEG = 0.5


def required_buffer(max_height: float, min_altitude: float) -> float:
    """Metres of surrounding surface needed so no shadow is truncated."""
    return max_height * shadow_ratio(min_altitude)


def cast_shadow(surface: np.ndarray,
                altitude: float,
                azimuth: float,
                resolution: float,
                max_distance: float) -> np.ndarray:
    if altitude <= HORIZON_DEG:
        return np.ones(surface.shape, dtype=bool)

    azimuth_rad = math.radians(azimuth)
    step_x = math.sin(azimuth_rad)
    step_y = -math.cos(azimuth_rad)       # rows increase southward
    rise = math.tan(math.radians(altitude))

    shaded = np.zeros(surface.shape, dtype=bool)
    height, width = surface.shape
    for step in range(1, int(max_distance / resolution) + 1):
        offset_x = int(round(step * step_x))
        offset_y = int(round(step * step_y))
        if abs(offset_x) >= width or abs(offset_y) >= height:
            break
        shifted = np.full(surface.shape, -9999.0, dtype="float32")
        src_rows = slice(max(0, offset_y), height + min(0, offset_y))
        dst_rows = slice(max(0, -offset_y), height + min(0, -offset_y))
        src_cols = slice(max(0, offset_x), width + min(0, offset_x))
        dst_cols = slice(max(0, -offset_x), width + min(0, -offset_x))
        shifted[dst_rows, dst_cols] = surface[src_rows, src_cols]
        shaded |= (shifted - step * resolution * rise) > surface
    return shaded


def hour_bitmask(surface: np.ndarray,
                 frames,
                 resolution: float,
                 max_distance: float | None = None,
                 max_height: float | None = None) -> np.ndarray:
    """Pack one shadow mask per frame into a 16 bit raster.

    Give either `max_distance`, a single sweep length used for every frame,
    or `max_height`, the tallest object in the surface, from which each
    frame's sweep is sized to its own sun angle. The second is the same
    answer for a fraction of the work, because a shadow at 66 degrees cannot
    reach as far as one at 8 and there is no point sweeping as if it could.
    """
    if (max_distance is None) == (max_height is None):
        raise ValueError("pass exactly one of max_distance or max_height")
    if len(frames) > 16:
        raise ValueError(f"{len(frames)} frames will not fit a 16 bit mask")
    bits = np.zeros(surface.shape, dtype=np.uint16)
    for position, frame in enumerate(frames):
        reach = (max_distance if max_height is None
                 else max_height * shadow_ratio(frame.altitude))
        mask = cast_shadow(surface, frame.altitude, frame.azimuth,
                           resolution, reach)
        bits |= (mask.astype(np.uint16) << position)
    return bits
