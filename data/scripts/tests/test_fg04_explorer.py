import unittest
import json
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Point

from fg04_explorer import (
    ALL_HOURS,
    GROUND,
    MISSING,
    NON_GROUND,
    UNDER_CANOPY,
    classify_pixels,
    classification_tile_url,
    decode_class_tile,
    downsample_classes,
    encode_class_tile,
    group_named_streets,
    is_walkable_street,
    normalize_street_name,
    paired_hourly_profile,
    walking_band,
)


class PointClassificationTests(unittest.TestCase):
    def test_classifies_missing_non_ground_ground_and_canopy_ground(self):
        coverage = np.array([[False, True], [True, True]])
        ground = np.array([[False, False], [True, True]])
        canopy = np.array([[False, True], [False, True]])

        result = classify_pixels(coverage, ground, canopy)

        np.testing.assert_array_equal(
            result,
            [[MISSING, NON_GROUND], [GROUND, UNDER_CANOPY]],
        )
        self.assertEqual(result.dtype, np.uint8)

    def test_rejects_different_input_shapes(self):
        with self.assertRaises(ValueError):
            classify_pixels(
                np.ones((2, 2), dtype=bool),
                np.ones((2, 1), dtype=bool),
                np.ones((2, 2), dtype=bool),
            )


class ClassificationAggregationTests(unittest.TestCase):
    def test_ground_requires_half_of_the_four_children(self):
        classes = np.array(
            [[GROUND, MISSING, GROUND, MISSING],
             [GROUND, MISSING, GROUND, NON_GROUND],
             [NON_GROUND, NON_GROUND, MISSING, MISSING],
             [NON_GROUND, MISSING, MISSING, MISSING]],
            dtype=np.uint8,
        )

        result = downsample_classes(classes)

        np.testing.assert_array_equal(
            result,
            [[GROUND, GROUND], [NON_GROUND, MISSING]],
        )

    def test_canopy_wins_a_tie_among_ground_children(self):
        classes = np.array(
            [[UNDER_CANOPY, GROUND], [NON_GROUND, NON_GROUND]],
            dtype=np.uint8,
        )

        result = downsample_classes(classes)

        self.assertEqual(int(result[0, 0]), UNDER_CANOPY)


class ClassificationTileTests(unittest.TestCase):
    def test_lossless_rgb_contract_round_trips_every_class(self):
        classes = np.array(
            [[MISSING, NON_GROUND], [GROUND, UNDER_CANOPY]], dtype=np.uint8)

        pixels = encode_class_tile(classes)
        result = decode_class_tile(pixels, verify=True)

        np.testing.assert_array_equal(result, classes)
        np.testing.assert_array_equal(pixels[:, :, 0], classes)
        self.assertFalse(pixels[:, :, 1:].any())

    def test_class_url_has_an_independent_immutable_version(self):
        self.assertEqual(
            classification_tile_url(),
            "https://tiles.torontomicroatlas.com/fg04/class/v2/"
            "{z}/{x}/{y}.webp",
        )


class StreetSelectionTests(unittest.TestCase):
    def test_keeps_named_walkable_streets(self):
        self.assertTrue(is_walkable_street(
            {"name": "Mill Street", "highway": "residential"}))
        self.assertTrue(is_walkable_street(
            {"name": "Queen Street West", "highway": "primary"}))

    def test_excludes_motorways_service_aisles_and_foot_restrictions(self):
        cases = [
            {"name": "Highway 401", "highway": "motorway"},
            {"name": "Loading Lane", "highway": "service"},
            {"name": "Private Road", "highway": "residential", "foot": "no"},
            {"highway": "residential"},
        ]

        for tags in cases:
            with self.subTest(tags=tags):
                self.assertFalse(is_walkable_street(tags))

    def test_groups_case_and_spacing_variants_under_one_display_name(self):
        features = [
            {"tags": {"name": "York Street", "highway": "primary"},
             "geometry": LineString([(0, 0), (0, 100)])},
            {"tags": {"name": "  york   STREET  ", "highway": "residential"},
             "geometry": LineString([(0, 100), (0, 180)])},
            {"tags": {"name": "Loading Lane", "highway": "service"},
             "geometry": LineString([(10, 0), (10, 100)])},
        ]

        groups = group_named_streets(features)

        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].name, "York Street")
        self.assertEqual(groups[0].id, "york-street")
        self.assertAlmostEqual(groups[0].geometry.length, 180.0)

    def test_normalization_is_unicode_and_whitespace_stable(self):
        self.assertEqual(
            normalize_street_name("  Rue  d’ Orléans "),
            normalize_street_name("Rue d’ Orléans"),
        )


class WalkingBandTests(unittest.TestCase):
    def test_band_includes_only_points_eight_to_fifteen_metres_from_line(self):
        line = LineString([(0, 0), (100, 0)])

        band = walking_band(line)

        self.assertFalse(band.covers(Point(50, 7.9)))
        self.assertTrue(band.covers(Point(50, 8.1)))
        self.assertTrue(band.covers(Point(50, 14.9)))
        self.assertFalse(band.covers(Point(50, 15.1)))


class PairedProfileTests(unittest.TestCase):
    def test_returns_one_fraction_per_hour_for_both_surfaces(self):
        measured = np.array([[0b001, 0b011], [0b101, 0]], dtype=np.uint16)
        corrected = np.array([[0b001, 0b001], [0b111, 0]], dtype=np.uint16)
        sample = np.array([[True, True], [True, False]])
        classes = np.array(
            [[GROUND, UNDER_CANOPY], [GROUND, NON_GROUND]], dtype=np.uint8)

        profile = paired_hourly_profile(
            measured, corrected, sample, classes, hours=3)

        self.assertEqual(profile.ground_pixels, 3)
        self.assertEqual(profile.measured, [1.0, 1 / 3, 1 / 3])
        self.assertEqual(profile.corrected, [1.0, 2 / 3, 2 / 3])
        self.assertEqual(int(profile.corrected_bits[0, 1]), ALL_HOURS)

    def test_no_ground_is_no_data_not_zero_shade(self):
        bits = np.zeros((2, 2), dtype=np.uint16)
        sample = np.ones((2, 2), dtype=bool)
        classes = np.full((2, 2), NON_GROUND, dtype=np.uint8)

        profile = paired_hourly_profile(bits, bits, sample, classes, hours=3)

        self.assertEqual(profile.ground_pixels, 0)
        self.assertEqual(profile.measured, [None, None, None])
        self.assertEqual(profile.corrected, [None, None, None])


class ExplorerArtifactTests(unittest.TestCase):
    ROOT = Path(__file__).parents[3]

    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(
            (cls.ROOT / "public/data/fg04/manifest.json").read_text())
        cls.profiles = json.loads(
            (cls.ROOT / "public/data/fg04/street-profiles.json").read_text())

    def test_manifest_adds_class_v2_without_moving_shade_v3(self):
        self.assertEqual(self.manifest["tileVersion"], "v3")
        self.assertEqual(self.manifest["classification"]["version"], "v2")
        self.assertEqual(
            self.manifest["classification"]["tilesWritten"], 10_159)
        self.assertIn("ties to even", self.manifest["countAggregation"])

    def test_street_asset_is_paired_and_has_fifteen_clock_frames(self):
        streets = self.profiles["streets"]
        self.assertEqual(len(streets), 8_507)
        self.assertEqual(self.profiles["hours"], list(range(6, 21)))
        for street in streets:
            self.assertEqual(len(street["measured"]), 15)
            self.assertEqual(len(street["corrected"]), 15)
            if street["groundPixels"] == 0:
                self.assertEqual(street["measured"], [None] * 15)
                self.assertEqual(street["corrected"], [None] * 15)

    def test_matching_grain_york_anchor_reproduces_phase_zero(self):
        evidence = self.profiles["anchorEvidence"]["York Street"]

        self.assertEqual(
            evidence["measured"]["profileFractionSum"], 11.70)
        self.assertEqual(
            evidence["corrected"]["profileFractionSum"], 11.74)
        self.assertEqual(evidence["groundPixels"], 902)

    def test_no_fg04_tile_pyramid_is_in_the_deployable_tree(self):
        fg04 = self.ROOT / "public/data/fg04"

        self.assertFalse((fg04 / "tiles").exists())
        self.assertFalse((fg04 / "class-tiles").exists())


if __name__ == "__main__":
    unittest.main()
