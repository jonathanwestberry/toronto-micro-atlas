import unittest

import numpy as np

from fg04_canopy import correct_leaf_off, correction_report


class LeafOnCorrectionTests(unittest.TestCase):
    def test_bare_canopy_pixels_rise_to_the_local_crown_height(self):
        surface = np.zeros((100, 100), dtype="float32")
        canopy = np.zeros((100, 100), dtype=bool)
        canopy[20:80, 20:80] = True
        surface[20:80, 20:50] = 12.0          # branches that did return
        surface[20:80, 50:80] = 0.4           # bare, missed by the flight

        corrected = correct_leaf_off(surface, canopy)

        self.assertAlmostEqual(float(corrected[50, 60]), 12.0, delta=1.5)

    def test_pixels_outside_the_canopy_mask_are_untouched(self):
        surface = np.zeros((60, 60), dtype="float32")
        surface[10:20, 10:20] = 40.0          # a building
        canopy = np.zeros((60, 60), dtype=bool)

        corrected = correct_leaf_off(surface, canopy)

        np.testing.assert_array_equal(corrected, surface)

    def test_tall_canopy_pixels_are_not_lowered(self):
        surface = np.zeros((60, 60), dtype="float32")
        surface[10:50, 10:50] = 18.0
        canopy = np.zeros((60, 60), dtype=bool)
        canopy[10:50, 10:50] = True

        corrected = correct_leaf_off(surface, canopy)

        self.assertAlmostEqual(float(corrected[30, 30]), 18.0, delta=0.01)

    def test_default_height_applies_where_no_local_crown_exists(self):
        surface = np.zeros((40, 40), dtype="float32")
        canopy = np.zeros((40, 40), dtype=bool)
        canopy[5:35, 5:35] = True             # everything bare

        corrected = correct_leaf_off(surface, canopy, default_height=8.0)

        self.assertAlmostEqual(float(corrected[20, 20]), 8.0, delta=0.01)

    def test_report_counts_what_the_correction_changed(self):
        surface = np.zeros((40, 40), dtype="float32")
        canopy = np.zeros((40, 40), dtype=bool)
        canopy[5:35, 5:35] = True

        corrected = correct_leaf_off(surface, canopy)
        report = correction_report(surface, corrected, canopy)

        self.assertEqual(report["canopy_pixels"], 900)
        self.assertEqual(report["raised_pixels"], 900)
        self.assertGreater(report["mean_rise_m"], 0)
