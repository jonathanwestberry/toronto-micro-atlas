import unittest

import numpy as np

from fg04_stats import (FRAMES, HOURS, all_hours, bit_for_hour, block_swing,
                        frame_share, histogram,
                        mean_from_histogram,
                        median_from_histogram, shaded_hours, shadiest_among,
                        shortage_share)


class ShadedHoursTests(unittest.TestCase):
    def test_counts_only_the_fifteen_daylight_bits(self):
        bits = np.array([[0b0, 0b1, 0b101, 0x7FFF]], dtype=np.uint16)

        hours = shaded_hours(bits)

        np.testing.assert_array_equal(hours, [[0, 1, 2, 15]])

    def test_a_sixteenth_bit_is_ignored(self):
        # Nothing should ever set bit 15, but if it does it is not an hour
        # and must not inflate the count past the modelled day.
        bits = np.array([[0x8000, 0xFFFF]], dtype=np.uint16)

        hours = shaded_hours(bits)

        np.testing.assert_array_equal(hours, [[0, FRAMES]])

    def test_result_is_small_and_unsigned(self):
        bits = np.zeros((4, 4), dtype=np.uint16)

        self.assertEqual(shaded_hours(bits).dtype, np.uint8)


class HistogramTests(unittest.TestCase):
    def test_accumulates_counts_per_zone_and_hour(self):
        counts = np.zeros((3, HOURS), dtype=np.int64)
        labels = np.array([[1, 1, 2], [2, 0, 1]])
        hours = np.array([[4, 4, 9], [9, 3, 7]], dtype=np.uint8)
        keep = np.ones(labels.shape, dtype=bool)

        histogram(counts, labels, hours, keep, 3)

        self.assertEqual(counts[1, 4], 2)
        self.assertEqual(counts[1, 7], 1)
        self.assertEqual(counts[2, 9], 2)
        self.assertEqual(counts[0, 3], 1)

    def test_pixels_outside_keep_are_not_counted(self):
        counts = np.zeros((2, HOURS), dtype=np.int64)
        labels = np.array([[1, 1]])
        hours = np.array([[5, 6]], dtype=np.uint8)
        keep = np.array([[True, False]])

        histogram(counts, labels, hours, keep, 2)

        self.assertEqual(counts[1].sum(), 1)
        self.assertEqual(counts[1, 5], 1)

    def test_accumulates_across_repeated_calls(self):
        counts = np.zeros((2, HOURS), dtype=np.int64)
        labels = np.array([[1]])
        hours = np.array([[8]], dtype=np.uint8)
        keep = np.ones((1, 1), dtype=bool)

        histogram(counts, labels, hours, keep, 2)
        histogram(counts, labels, hours, keep, 2)

        self.assertEqual(counts[1, 8], 2)


class SummaryTests(unittest.TestCase):
    def test_mean_matches_a_plain_average(self):
        counts = np.zeros((1, HOURS), dtype=np.int64)
        counts[0, 2] = 3
        counts[0, 10] = 1

        mean = mean_from_histogram(counts)[0]

        self.assertAlmostEqual(mean, (2 * 3 + 10) / 4)

    def test_median_matches_numpy_on_the_same_values(self):
        values = np.array([1, 1, 4, 7, 7, 7, 12])
        counts = np.zeros((1, HOURS), dtype=np.int64)
        for value in values:
            counts[0, value] += 1

        self.assertEqual(median_from_histogram(counts)[0], np.median(values))

    def test_empty_zones_report_not_a_number_rather_than_zero(self):
        # An unsampled street must not read as a street with no shade.
        counts = np.zeros((2, HOURS), dtype=np.int64)
        counts[1, 6] = 5

        self.assertTrue(np.isnan(mean_from_histogram(counts)[0]))
        self.assertTrue(np.isnan(median_from_histogram(counts)[0]))
        self.assertEqual(mean_from_histogram(counts)[1], 6)


class ShortageTests(unittest.TestCase):
    def test_share_is_measured_in_kilometres_not_segment_count(self):
        # One long shaded road against three short bare stubs: by count the
        # shortage looks like 75 per cent, by length it is 3 per cent.
        medians = np.array([12.0, 1.0, 1.0, 1.0])
        lengths = np.array([9700.0, 100.0, 100.0, 100.0])
        arterial = np.array([True, True, True, True])

        share, poor_km, total_km = shortage_share(
            medians, lengths, arterial, n=5)

        self.assertAlmostEqual(total_km, 10.0)
        self.assertAlmostEqual(poor_km, 0.3)
        self.assertAlmostEqual(share, 3.0)

    def test_unsampled_segments_are_excluded_from_both_sides(self):
        medians = np.array([np.nan, 1.0])
        lengths = np.array([1000.0, 1000.0])
        arterial = np.array([True, True])

        share, poor_km, total_km = shortage_share(
            medians, lengths, arterial, n=5)

        self.assertAlmostEqual(total_km, 1.0)
        self.assertAlmostEqual(poor_km, 1.0)
        self.assertAlmostEqual(share, 100.0)

    def test_non_arterial_segments_do_not_count(self):
        medians = np.array([1.0, 1.0])
        lengths = np.array([1000.0, 1000.0])
        arterial = np.array([True, False])

        share, poor_km, total_km = shortage_share(
            medians, lengths, arterial, n=5)

        self.assertAlmostEqual(total_km, 1.0)
        self.assertAlmostEqual(poor_km, 1.0)


class ShadiestAmongTests(unittest.TestCase):
    """Ranking a subset of the arterials.

    The shadiest arterial in Toronto is York Street, which is downtown, and
    a reader who does not live downtown learns nothing from it. This picks
    the best street from whatever subset the caller is entitled to rank.
    """

    def test_picks_the_highest_mean_in_the_subset(self):
        means = np.array([11.7, 9.4, 10.2, 3.1])
        eligible = np.array([False, True, True, True])

        self.assertEqual(shadiest_among(means, eligible), 2)

    def test_an_unsampled_segment_never_wins(self):
        """NaN is a street nobody measured, not a street with infinite shade."""
        means = np.array([np.nan, 9.4, np.nan])
        eligible = np.array([True, True, True])

        self.assertEqual(shadiest_among(means, eligible), 1)

    def test_no_eligible_segment_returns_nothing(self):
        means = np.array([11.7, 9.4])
        eligible = np.array([False, False])

        self.assertIsNone(shadiest_among(means, eligible))

    def test_every_eligible_segment_unsampled_returns_nothing(self):
        means = np.array([np.nan, np.nan])
        eligible = np.array([True, True])

        self.assertIsNone(shadiest_among(means, eligible))

    def test_excluding_the_leader_promotes_the_runner_up(self):
        means = np.array([11.7, 10.2, 9.4])

        everywhere = shadiest_among(means, np.array([True, True, True]))
        without_leader = shadiest_among(means, np.array([False, True, True]))

        self.assertEqual(everywhere, 0)
        self.assertEqual(without_leader, 1)

    def test_minimum_length_excludes_a_short_tagging_artefact(self):
        means = np.array([11.5, 10.8, 9.4])
        eligible = np.array([True, True, True])
        lengths_m = np.array([310.0, 1400.0, 8000.0])

        winner = shadiest_among(
            means, eligible, lengths_m=lengths_m, minimum_length_m=1000.0)

        self.assertEqual(winner, 1)


class DowntownMaskTests(unittest.TestCase):
    """Which arterials count as downtown.

    Excluding downtown is what makes "the shadiest street outside downtown"
    a real answer rather than York Street again, so the exclusion has to be
    exactly the set that was agreed and has to fail loudly if the
    neighbourhood names ever move under it.
    """

    def setUp(self):
        import importlib.util
        from pathlib import Path

        path = Path(__file__).parents[1] / "32_fg04_stats.py"
        spec = importlib.util.spec_from_file_location("fg04_stats_script",
                                                      path)
        self.script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.script)

    def hoods(self, names):
        import geopandas as gpd
        from shapely.geometry import box

        boxes = [box(0, 0, 100, 100)] * len(names)
        return gpd.GeoDataFrame({"AREA_NAME": list(names),
                                 "geometry": boxes}, crs="EPSG:6660")

    def segments(self, lines):
        import geopandas as gpd
        from shapely.geometry import LineString

        return gpd.GeoDataFrame(
            {"geometry": [LineString(coords) for coords in lines]},
            crs="EPSG:6660")

    def test_a_street_inside_downtown_is_excluded(self):
        hoods = self.hoods(sorted(self.script.DOWNTOWN))
        segments = self.segments([[(10, 10), (20, 20)]])

        mask = self.script.downtown_mask(segments, hoods)

        self.assertTrue(bool(mask[0]))

    def test_a_street_nowhere_near_downtown_is_kept(self):
        hoods = self.hoods(sorted(self.script.DOWNTOWN))
        segments = self.segments([[(500, 500), (600, 600)]])

        mask = self.script.downtown_mask(segments, hoods)

        self.assertFalse(bool(mask[0]))

    def test_a_street_that_only_clips_downtown_is_still_excluded(self):
        """Half of University Avenue is not an answer to where else there is
        shade, so touching downtown at all is enough."""
        hoods = self.hoods(sorted(self.script.DOWNTOWN))
        segments = self.segments([[(90, 90), (900, 900)]])

        mask = self.script.downtown_mask(segments, hoods)

        self.assertTrue(bool(mask[0]))

    def test_a_renamed_neighbourhood_stops_the_run(self):
        # Silently shrinking the exclusion would hand the superlative back
        # to a downtown street without anything looking wrong.
        names = sorted(self.script.DOWNTOWN)[1:]
        hoods = self.hoods(names)
        segments = self.segments([[(10, 10), (20, 20)]])

        with self.assertRaises(SystemExit):
            self.script.downtown_mask(segments, hoods)

    def test_the_agreed_set_is_seventeen_neighbourhoods(self):
        self.assertEqual(len(self.script.DOWNTOWN), 17)
        self.assertIn("Yonge-Bay Corridor", self.script.DOWNTOWN)
        self.assertIn("Kensington-Chinatown", self.script.DOWNTOWN)
        self.assertNotIn("Downsview", self.script.DOWNTOWN)


class FrameShareTests(unittest.TestCase):
    """Ground shaded in a single frame.

    July's published minimum, 10.73% raw and 19.70% corrected at 13:00, is
    exactly this statistic. Chapter six's winter figure is the same one at
    January midday, which is the only reason the two can sit side by side.
    """

    def test_counts_only_ground_pixels(self):
        bits = np.array([[1, 1, 1, 1]], dtype=np.uint16)
        ground = np.array([[True, True, False, False]])

        total, shaded = frame_share(bits, ground, bit=0)

        self.assertEqual(total, 2)
        self.assertEqual(shaded, 2)

    def test_reads_the_requested_bit_and_no_other(self):
        # bit 0 set, bit 1 clear, on every pixel.
        bits = np.array([[0b01, 0b01]], dtype=np.uint16)
        ground = np.ones((1, 2), dtype=bool)

        self.assertEqual(frame_share(bits, ground, bit=0), (2, 2))
        self.assertEqual(frame_share(bits, ground, bit=1), (2, 0))

    def test_a_block_with_no_ground_contributes_nothing(self):
        bits = np.ones((2, 2), dtype=np.uint16)
        ground = np.zeros((2, 2), dtype=bool)

        self.assertEqual(frame_share(bits, ground, bit=0), (0, 0))

    def test_all_hours_for_a_partial_raster_is_not_the_july_constant(self):
        """A one-frame raster's "shaded all day" is 0b1, not 0x7FFF.

        Reusing the July constant would set fourteen bits that do not exist
        in the file, and the under-canopy override would then read as shaded
        in frames the raster never modelled.
        """
        self.assertEqual(all_hours(1), 0b1)
        self.assertEqual(all_hours(15), 0x7FFF)
        self.assertEqual(all_hours(FRAMES), 0x7FFF)


class BitForHourTests(unittest.TestCase):
    """Which bit is which hour.

    The July raster packs 06:00 into bit 0, so 13:00 is bit 7 and 18:00 is
    bit 12. Hardcoding those would break the moment a raster holds a
    selected hour instead of the whole day, which is exactly what the
    January build produces.
    """

    def setUp(self):
        from fg04_solar import hourly_frames
        self.july = hourly_frames("2026-07-21")
        self.winter = hourly_frames("2026-01-21")

    def test_july_six_am_is_bit_zero(self):
        self.assertEqual(bit_for_hour(self.july, 6), 0)

    def test_july_one_pm_is_bit_seven(self):
        self.assertEqual(bit_for_hour(self.july, 13), 7)

    def test_july_six_pm_is_bit_twelve(self):
        self.assertEqual(bit_for_hour(self.july, 18), 12)

    def test_a_winter_raster_numbers_its_own_hours(self):
        # 08:00 is the first winter frame, so it is bit 0, not bit 2.
        self.assertEqual(bit_for_hour(self.winter, 8), 0)
        self.assertEqual(bit_for_hour(self.winter, 12), 4)

    def test_an_hour_the_raster_does_not_hold_is_an_error(self):
        with self.assertRaises(ValueError):
            bit_for_hour(self.winter, 6)


class BlockSwingTests(unittest.TestCase):
    """Scoring a candidate block for the shareable frame.

    The frame has to show a swing between noon and six, and it has to be
    picked from the data rather than by eye. A block that is mostly lake
    scores beautifully and shows nothing, so ground has to be a floor
    rather than a tiebreak.
    """

    def test_a_block_that_goes_from_sunlit_to_shaded_scores_high(self):
        noon = np.zeros((10, 10), dtype=bool)
        six = np.ones((10, 10), dtype=bool)
        ground = np.ones((10, 10), dtype=bool)

        swing = block_swing(noon, six, ground, min_ground=0.25)

        self.assertAlmostEqual(swing, 1.0)

    def test_a_block_already_shaded_at_noon_scores_nothing(self):
        noon = np.ones((10, 10), dtype=bool)
        six = np.ones((10, 10), dtype=bool)
        ground = np.ones((10, 10), dtype=bool)

        self.assertAlmostEqual(block_swing(noon, six, ground, 0.25), 0.0)

    def test_a_block_with_too_little_ground_is_refused(self):
        noon = np.zeros((10, 10), dtype=bool)
        six = np.ones((10, 10), dtype=bool)
        ground = np.zeros((10, 10), dtype=bool)
        ground[0, :] = True                      # 10% ground

        self.assertIsNone(block_swing(noon, six, ground, min_ground=0.25))

    def test_only_ground_pixels_count_towards_the_swing(self):
        noon = np.zeros((10, 10), dtype=bool)
        six = np.zeros((10, 10), dtype=bool)
        six[:5, :] = True                        # roofs, not ground
        ground = np.zeros((10, 10), dtype=bool)
        ground[5:, :] = True

        self.assertAlmostEqual(block_swing(noon, six, ground, 0.25), 0.0)

    def test_a_block_with_no_ground_at_all_is_refused(self):
        empty = np.zeros((4, 4), dtype=bool)

        self.assertIsNone(block_swing(empty, empty, empty, 0.25))
