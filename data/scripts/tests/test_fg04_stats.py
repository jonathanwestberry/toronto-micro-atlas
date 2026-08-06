import unittest

import numpy as np

from fg04_stats import (FRAMES, HOURS, histogram, mean_from_histogram,
                        median_from_histogram, shaded_hours, shortage_share)


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
