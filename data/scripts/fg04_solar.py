"""Sun geometry for the modelled day.

The reader sees clock time. The model needs altitude and azimuth. Solar noon
in Toronto on 21 July falls near 13:25 EDT, not 12:00, because of the city's
position within the Eastern zone, daylight time, and the equation of time.
Converting once, here, keeps that 85 minute error out of everything else.
"""

import math
from dataclasses import dataclass

import pandas as pd
import pvlib

MODEL_DATE = "2026-07-21"

# Chapter six's date. The guide is a July guide and this is the only winter
# figure in it, chosen as 21 January to mirror 21 July rather than for any
# property of the day itself.
WINTER_DATE = "2026-01-21"

TZ = "America/Toronto"
TORONTO = (43.6532, -79.3832)
FIRST_HOUR = 6
LAST_HOUR = 20


@dataclass(frozen=True)
class SunFrame:
    clock: pd.Timestamp
    altitude: float
    azimuth: float


def _positions(index: pd.DatetimeIndex) -> pd.DataFrame:
    latitude, longitude = TORONTO
    return pvlib.solarposition.get_solarposition(index, latitude, longitude)


def solar_noon(date: str = MODEL_DATE) -> pd.Timestamp:
    index = pd.date_range(f"{date} 04:00", f"{date} 22:00", freq="1min", tz=TZ)
    return _positions(index)["apparent_elevation"].idxmax()


def hourly_frames(date: str = MODEL_DATE) -> list[SunFrame]:
    index = pd.date_range(
        f"{date} {FIRST_HOUR:02d}:00", f"{date} {LAST_HOUR:02d}:00",
        freq="1h", tz=TZ)
    positions = _positions(index)
    frames = []
    for clock, row in positions.iterrows():
        altitude = float(row["apparent_elevation"])
        if altitude <= 0:
            continue
        frames.append(SunFrame(
            clock=clock, altitude=altitude, azimuth=float(row["azimuth"])))
    if len(frames) > 16:
        raise RuntimeError(
            f"{len(frames)} frames will not fit a 16 bit mask")
    return frames


def frame_nearest_solar_noon(date: str = MODEL_DATE) -> SunFrame:
    """The modelled hour closest to solar noon on `date`.

    This is already the convention behind the published 13:00 figure: solar
    noon on 21 July is 13:24, and 13:00 is the nearest hour the model has.
    Naming it here means the winter figure follows the same rule instead of
    a hardcoded hour, and the rule is what makes the two comparable.
    """
    frames = hourly_frames(date)
    if not frames:
        raise ValueError(f"no daylight frames on {date}")
    noon = solar_noon(date)
    return min(frames, key=lambda frame: abs(frame.clock - noon))


def shadow_ratio(altitude_deg: float) -> float:
    """Shadow length as a multiple of object height."""
    if altitude_deg <= 0:
        raise ValueError("the sun is below the horizon")
    return 1.0 / math.tan(math.radians(altitude_deg))
