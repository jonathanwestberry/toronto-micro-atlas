import unittest

import geopandas as gpd
import numpy as np
from rasterio.transform import from_origin
from shapely.geometry import box

from fg04_canopy import (BUILDING_CODE, TREE_CODE, class_mask,
                         correct_leaf_off, correction_report)


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


def cover_frame(crs="EPSG:2952"):
    """A tree square on the left, a building square on the right."""
    return gpd.GeoDataFrame(
        {
            "gridcode": [TREE_CODE, BUILDING_CODE],
            "geometry": [box(0, 0, 10, 20), box(10, 0, 20, 20)],
        },
        crs=crs,
    )


class ClassMaskTests(unittest.TestCase):
    # 20 x 20 metre grid at 1 m, origin at the top left corner
    SHAPE = (20, 20)
    TRANSFORM = from_origin(0, 20, 1, 1)

    def test_rasterises_only_the_requested_class(self):
        mask = class_mask(cover_frame(), {TREE_CODE},
                          self.SHAPE, self.TRANSFORM, "EPSG:2952")

        self.assertTrue(mask[:, :10].all())      # the tree square
        self.assertFalse(mask[:, 10:].any())     # the building square

    def test_a_different_class_selects_a_different_square(self):
        mask = class_mask(cover_frame(), {BUILDING_CODE},
                          self.SHAPE, self.TRANSFORM, "EPSG:2952")

        self.assertFalse(mask[:, :10].any())
        self.assertTrue(mask[:, 10:].all())

    def test_several_classes_can_be_requested_at_once(self):
        mask = class_mask(cover_frame(), {TREE_CODE, BUILDING_CODE},
                          self.SHAPE, self.TRANSFORM, "EPSG:2952")

        self.assertTrue(mask.all())

    def test_an_absent_class_gives_an_empty_mask(self):
        mask = class_mask(cover_frame(), {7},
                          self.SHAPE, self.TRANSFORM, "EPSG:2952")

        self.assertFalse(mask.any())
        self.assertEqual(mask.dtype, np.dtype(bool))

    def test_source_geometry_is_reprojected_to_the_target_crs(self):
        # The same ground, described in degrees, must land on the same pixels.
        native = cover_frame()
        degrees = native.to_crs("EPSG:4326")

        from_native = class_mask(native, {TREE_CODE}, self.SHAPE,
                                 self.TRANSFORM, "EPSG:2952")
        from_degrees = class_mask(degrees, {TREE_CODE}, self.SHAPE,
                                  self.TRANSFORM, "EPSG:2952")

        np.testing.assert_array_equal(from_degrees, from_native)


class CorrectionSourceTests(unittest.TestCase):
    """Whether a raised pixel was measured from a neighbour or assumed.

    The difference decides how much of the leaf-on figure is evidence. A
    correction that mostly fell back to `default_height` is a modelled
    input wearing a measurement's clothes, and the guide has to say so.
    """

    def test_detail_counts_pixels_measured_from_a_local_crown(self):
        surface = np.zeros((100, 100), dtype="float32")
        canopy = np.zeros((100, 100), dtype=bool)
        canopy[20:80, 20:80] = True
        surface[20:80, 20:50] = 12.0      # crowns the flight did catch
        surface[20:80, 50:80] = 0.4       # bare, but crowns are nearby

        _, detail = correct_leaf_off(surface, canopy, with_detail=True)

        bare = 60 * 30
        self.assertEqual(detail["measured_pixels"]
                         + detail["defaulted_pixels"], bare)
        # Most of the bare patch is within the 51 px window of a crown. The
        # far edge is not, and takes the default: reach is half the window,
        # so the last 5 of 30 bare columns are out of range.
        self.assertEqual(detail["defaulted_pixels"], 5 * 60)
        self.assertEqual(detail["measured_pixels"], 25 * 60)

    def test_detail_counts_pixels_that_fell_back_to_the_default(self):
        surface = np.zeros((40, 40), dtype="float32")
        canopy = np.zeros((40, 40), dtype=bool)
        canopy[5:35, 5:35] = True         # every canopy pixel is bare

        _, detail = correct_leaf_off(surface, canopy, with_detail=True)

        self.assertEqual(detail["measured_pixels"], 0)
        self.assertEqual(detail["defaulted_pixels"], 900)

    def test_without_detail_the_return_is_still_a_bare_array(self):
        surface = np.zeros((20, 20), dtype="float32")
        canopy = np.zeros((20, 20), dtype=bool)

        result = correct_leaf_off(surface, canopy)

        self.assertIsInstance(result, np.ndarray)
