import math
import unittest

import numpy as np

from fg04_shadow import cast_shadow, hour_bitmask, required_buffer
from fg04_solar import SunFrame, shadow_ratio
import pandas as pd


def scene_with_tower(height, altitude, azimuth, size=1200, resolution=0.5):
    """One tower on flat ground, placed so its shadow stays inside the array."""
    surface = np.zeros((size, size), dtype="float32")
    away_x = -math.sin(math.radians(azimuth))
    away_y = math.cos(math.radians(azimuth))
    row = int(size / 2 - away_y * size * 0.35)
    col = int(size / 2 - away_x * size * 0.35)
    surface[row - 10:row + 10, col - 10:col + 10] = height
    return surface, row, col, away_x, away_y


def measure_reach(mask, row, col, away_x, away_y, resolution):
    reach = 0.0
    size = mask.shape[0]
    for step in range(1, int(size * 0.9)):
        r = int(round(row + away_y * step))
        c = int(round(col + away_x * step))
        if not (0 <= r < size and 0 <= c < size):
            break
        if mask[r, c]:
            reach = step * resolution
    return reach


class ShadowCastingTests(unittest.TestCase):
    def test_shadow_length_matches_the_geometry(self):
        height, altitude, azimuth = 100.0, 30.0, 270.0
        predicted = height * shadow_ratio(altitude)
        surface, row, col, ax, ay = scene_with_tower(height, altitude, azimuth)

        mask = cast_shadow(surface, altitude, azimuth,
                           resolution=0.5, max_distance=predicted * 1.4)

        reach = measure_reach(mask, row, col, ax, ay, 0.5)
        self.assertLess(abs(reach - predicted) / predicted, 0.10)

    def test_a_lower_sun_casts_a_longer_shadow(self):
        height, azimuth = 60.0, 270.0
        reaches = []
        for altitude in (50.0, 20.0):
            predicted = height * shadow_ratio(altitude)
            surface, row, col, ax, ay = scene_with_tower(height, altitude, azimuth)
            mask = cast_shadow(surface, altitude, azimuth,
                               resolution=0.5, max_distance=predicted * 1.4)
            reaches.append(measure_reach(mask, row, col, ax, ay, 0.5))
        self.assertGreater(reaches[1], reaches[0] * 2)

    def test_flat_ground_casts_nothing(self):
        surface = np.zeros((200, 200), dtype="float32")

        mask = cast_shadow(surface, 45.0, 180.0, resolution=1.0, max_distance=50.0)

        self.assertFalse(mask.any())

    def test_everything_is_shaded_below_the_horizon(self):
        surface = np.zeros((50, 50), dtype="float32")

        mask = cast_shadow(surface, 0.2, 90.0, resolution=1.0, max_distance=50.0)

        self.assertTrue(mask.all())

    def test_required_buffer_covers_the_tallest_object_at_the_lowest_sun(self):
        buffer_m = required_buffer(max_height=352.6, min_altitude=7.8)

        self.assertGreater(buffer_m, 2500)
        self.assertLess(buffer_m, 3000)

    def test_bitmask_sets_one_bit_per_frame(self):
        surface = np.zeros((60, 60), dtype="float32")
        surface[28:32, 28:32] = 20.0
        frames = [
            SunFrame(pd.Timestamp("2026-07-21 09:00", tz="America/Toronto"), 30.0, 90.0),
            SunFrame(pd.Timestamp("2026-07-21 17:00", tz="America/Toronto"), 30.0, 270.0),
        ]

        bits = hour_bitmask(surface, frames, resolution=1.0, max_distance=60.0)

        self.assertEqual(bits.dtype, np.uint16)
        self.assertTrue((bits & 0b01).any())
        self.assertTrue((bits & 0b10).any())
        self.assertEqual(int(bits.max()) & ~0b11, 0)


class PerFrameDistanceTests(unittest.TestCase):
    """Sizing the sweep per frame instead of once at the worst case.

    Across the modelled day a 400 m object needs 11,304 m of total sweep when
    each frame is sized to its own sun angle, against 40,975 m when every
    frame uses the lowest sun's 2,927 m. Same answer, 3.6 times the work.
    """

    def _frames(self):
        stamp = pd.Timestamp("2026-07-21 09:00", tz="America/Toronto")
        return [SunFrame(stamp, 60.0, 90.0), SunFrame(stamp, 10.0, 270.0)]

    def test_max_height_gives_the_same_answer_as_a_generous_max_distance(self):
        surface = np.zeros((200, 200), dtype="float32")
        surface[98:102, 98:102] = 30.0
        frames = self._frames()

        generous = hour_bitmask(surface, frames, resolution=1.0,
                                max_distance=30.0 * shadow_ratio(10.0))
        sized = hour_bitmask(surface, frames, resolution=1.0, max_height=30.0)

        np.testing.assert_array_equal(sized, generous)

    def test_max_height_sweeps_the_low_sun_further_than_the_high_sun(self):
        surface = np.zeros((400, 400), dtype="float32")
        surface[198:202, 198:202] = 50.0
        frames = self._frames()

        bits = hour_bitmask(surface, frames, resolution=1.0, max_height=50.0)

        high = int((bits & 0b01).astype(bool).sum())
        low = int((bits & 0b10).astype(bool).sum())
        self.assertGreater(low, high * 2)

    def test_exactly_one_of_max_distance_and_max_height_is_required(self):
        surface = np.zeros((10, 10), dtype="float32")
        frames = self._frames()

        with self.assertRaises(ValueError):
            hour_bitmask(surface, frames, resolution=1.0)
        with self.assertRaises(ValueError):
            hour_bitmask(surface, frames, resolution=1.0,
                         max_distance=10.0, max_height=10.0)
