import unittest

from fg04_solar import (MODEL_DATE, WINTER_DATE, frame_nearest_solar_noon,
                       hourly_frames, shadow_ratio, solar_noon)


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


class WinterSunTests(unittest.TestCase):
    """The January sun, which chapter six is about.

    The guide is a July guide. These exist because chapter six promised the
    reader a computed winter figure, and a winter sun behaves differently
    enough that the promise could not be kept by rerunning the July path.
    """

    def test_winter_solar_noon_is_not_the_summer_one(self):
        noon = solar_noon(WINTER_DATE)

        self.assertEqual(noon.strftime("%Y-%m-%d"), "2026-01-21")
        self.assertEqual(noon.hour, 12)
        self.assertLess(noon.minute, 45)

    def test_the_modelled_hour_nearest_noon_is_thirteen_in_july(self):
        """The convention the published 13:00 figure already follows."""
        frame = frame_nearest_solar_noon(MODEL_DATE)

        self.assertEqual(frame.clock.hour, 13)
        self.assertAlmostEqual(frame.altitude, 66.2, delta=0.8)

    def test_the_modelled_hour_nearest_noon_is_twelve_in_january(self):
        frame = frame_nearest_solar_noon(WINTER_DATE)

        self.assertEqual(frame.clock.hour, 12)
        self.assertAlmostEqual(frame.altitude, 26.2, delta=0.8)

    def test_the_winter_sun_never_climbs_as_high_as_the_summer_one(self):
        winter = max(f.altitude for f in hourly_frames(WINTER_DATE))
        summer = max(f.altitude for f in hourly_frames(MODEL_DATE))

        self.assertLess(winter, summer / 2)

    def test_the_winter_day_is_shorter_than_the_modelled_window(self):
        """06:00 and 20:00 are dark in January, so fewer frames survive."""
        frames = hourly_frames(WINTER_DATE)

        self.assertEqual([f.clock.hour for f in frames],
                         list(range(8, 18)))

    def test_a_near_horizon_winter_frame_would_demand_a_twenty_km_margin(self):
        """Why the whole winter day was not computed.

        The lowest casting winter frame sits near 1.7 degrees, where a 600 m
        object throws almost 20 km. Padding every 8 km window by that is a
        24,000 px square read, 10 GB, and the sweep cost it implies was
        measured at 171 hours against July's 3.69. July escapes because its
        one near-horizon frame, 06:00 at 0.38 degrees, falls below the
        horizon cutoff and is excluded from the buffer arithmetic.
        """
        winter_lowest = min(f.altitude for f in hourly_frames(WINTER_DATE))
        summer_lowest = min(f.altitude for f in hourly_frames(MODEL_DATE)
                            if f.altitude > 0.5)

        self.assertLess(winter_lowest, 2.0)
        self.assertGreater(600.0 * shadow_ratio(winter_lowest), 19_000.0)
        self.assertLess(600.0 * shadow_ratio(summer_lowest), 4_500.0)

    def test_the_noon_frame_is_affordable(self):
        """The frame that was computed, and why it fits."""
        frame = frame_nearest_solar_noon(WINTER_DATE)

        self.assertLess(600.0 * shadow_ratio(frame.altitude), 1_500.0)
