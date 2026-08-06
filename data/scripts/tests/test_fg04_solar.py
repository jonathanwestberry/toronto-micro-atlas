import unittest

from fg04_solar import hourly_frames, shadow_ratio, solar_noon


class SolarGeometryTests(unittest.TestCase):
    def test_solar_noon_is_not_twelve_oclock(self):
        noon = solar_noon()

        self.assertEqual(noon.strftime("%Y-%m-%d"), "2026-07-21")
        self.assertEqual(noon.hour, 13)
        self.assertGreaterEqual(noon.minute, 15)
        self.assertLessEqual(noon.minute, 35)

    def test_peak_altitude_matches_the_published_figure(self):
        peak = max(frame.altitude for frame in hourly_frames())

        self.assertAlmostEqual(peak, 66.2, delta=0.8)

    def test_fifteen_daylight_frames_fit_a_sixteen_bit_mask(self):
        frames = hourly_frames()

        self.assertEqual(len(frames), 15)
        self.assertLessEqual(len(frames), 16)
        self.assertTrue(all(frame.altitude > 0 for frame in frames))

    def test_frames_are_hourly_and_ordered(self):
        frames = hourly_frames()

        hours = [frame.clock.hour for frame in frames]
        self.assertEqual(hours, list(range(6, 21)))

    def test_shadow_ratio_at_the_solar_maximum(self):
        self.assertAlmostEqual(shadow_ratio(66.72), 0.430, places=2)

    def test_shadow_ratio_grows_as_the_sun_drops(self):
        self.assertGreater(shadow_ratio(10.0), shadow_ratio(60.0))

    def test_shadow_ratio_refuses_a_sun_below_the_horizon(self):
        with self.assertRaises(ValueError):
            shadow_ratio(0.0)
