import math
import unittest

import numpy as np

from fg04_attribution import trace_caster
from fg04_shadow import cast_shadow


class PointCasterTests(unittest.TestCase):
    def test_returns_the_known_obstacle_that_blocks_the_sun(self):
        surface = np.zeros((80, 80), dtype=np.float32)
        surface[40, 20] = 10.0

        caster = trace_caster(
            surface, row=40, column=10, altitude=20.0, azimuth=90.0,
            resolution=1.0, max_distance=40.0)

        self.assertIsNotNone(caster)
        self.assertEqual((caster.row, caster.column), (40, 20))
        self.assertEqual(caster.distance_m, 10.0)
        self.assertEqual(caster.obstruction_height_m, 10.0)
        self.assertAlmostEqual(
            caster.apparent_altitude_deg,
            math.degrees(math.atan(1.0)), places=6)

    def test_the_highest_apparent_obstruction_controls_the_horizon(self):
        surface = np.zeros((80, 80), dtype=np.float32)
        surface[40, 20] = 4.0
        surface[40, 30] = 20.0

        caster = trace_caster(
            surface, row=40, column=10, altitude=20.0, azimuth=90.0,
            resolution=1.0, max_distance=40.0)

        self.assertIsNotNone(caster)
        self.assertEqual((caster.row, caster.column), (40, 30))
        self.assertEqual(caster.distance_m, 20.0)
        self.assertEqual(caster.obstruction_height_m, 20.0)

    def test_an_obstacle_below_the_sun_ray_is_not_a_caster(self):
        surface = np.zeros((80, 80), dtype=np.float32)
        surface[40, 30] = 2.0

        caster = trace_caster(
            surface, row=40, column=10, altitude=20.0, azimuth=90.0,
            resolution=1.0, max_distance=40.0)

        self.assertIsNone(caster)

    def test_point_trace_agrees_with_the_existing_shadow_sweep(self):
        surface = np.zeros((100, 100), dtype=np.float32)
        surface[45:55, 60:65] = 18.0
        cases = [(50, 30), (50, 55), (20, 20), (75, 75)]

        shaded = cast_shadow(
            surface, altitude=18.0, azimuth=90.0,
            resolution=1.0, max_distance=60.0)

        for row, column in cases:
            with self.subTest(row=row, column=column):
                caster = trace_caster(
                    surface, row=row, column=column, altitude=18.0,
                    azimuth=90.0, resolution=1.0, max_distance=60.0)
                self.assertEqual(caster is not None, bool(shaded[row, column]))

    def test_below_the_model_horizon_has_no_physical_caster(self):
        surface = np.zeros((20, 20), dtype=np.float32)

        caster = trace_caster(
            surface, row=10, column=10, altitude=0.38, azimuth=60.0,
            resolution=2.0, max_distance=100.0)

        self.assertIsNone(caster)

    def test_invalid_points_and_distances_are_rejected(self):
        surface = np.zeros((20, 20), dtype=np.float32)
        cases = [
            dict(row=-1, column=10, resolution=1.0, max_distance=10.0),
            dict(row=10, column=20, resolution=1.0, max_distance=10.0),
            dict(row=10, column=10, resolution=0.0, max_distance=10.0),
            dict(row=10, column=10, resolution=1.0, max_distance=0.0),
        ]

        for values in cases:
            with self.subTest(values=values), self.assertRaises(ValueError):
                trace_caster(
                    surface, altitude=20.0, azimuth=90.0, **values)


if __name__ == "__main__":
    unittest.main()
