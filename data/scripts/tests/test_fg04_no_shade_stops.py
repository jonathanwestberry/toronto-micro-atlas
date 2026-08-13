"""The published set of stops with no usable shade.

The count already had a home in the proof file. These tests guard the two
things a set can get wrong that a count cannot: which stops are in it, and
what order implies.
"""

import json
import os
import unittest

import numpy as np

from fg04_stats import bare_on_every_surface, no_shade_stop_records

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, "..", ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
PROOF_PATH = os.path.join(DATA, "proof", "fg04", "statistics.json")
PUBLISHED_PATH = os.path.join(
    ROOT, "public", "data", "fg04", "no-shade-stops.json")


class BareOnEverySurfaceTests(unittest.TestCase):
    def test_one_frame_is_bare_and_two_is_not(self):
        # One frame is the 06:00 frame alone, before anything is measured.
        hours = {"raw": np.array([1, 2, 0, 15])}

        mask = bare_on_every_surface(hours)

        np.testing.assert_array_equal(mask, [True, False, False, False])

    def test_it_intersects_rather_than_unions(self):
        # A stop bare only on the measured surface may be under a tree the
        # spring flight could not see. Publishing it would turn the flight
        # calendar into a finding.
        hours = {
            "raw": np.array([1, 1, 5]),
            "corrected": np.array([1, 4, 5]),
        }

        mask = bare_on_every_surface(hours)

        np.testing.assert_array_equal(mask, [True, False, False])

    def test_no_surfaces_is_an_error_not_an_empty_set(self):
        with self.assertRaises(ValueError):
            bare_on_every_surface({})


class RecordShapeTests(unittest.TestCase):
    def setUp(self):
        self.mask = np.array([True, False, True])
        self.names = ["Zoo Rd at Meadowvale", "Skipped Stop", "Adelaide St E"]
        self.ids = ["stop:9", "stop:5", "stop:1"]
        self.lons = [-79.1, -79.2, -79.3]
        self.lats = [43.8, 43.7, 43.6]

    def records(self):
        return no_shade_stop_records(
            self.mask, self.names, self.ids, self.lons, self.lats)

    def test_it_selects_only_the_masked_stops(self):
        records = self.records()

        self.assertEqual([r["id"] for r in records], ["stop:1", "stop:9"])

    def test_it_sorts_by_name_and_not_by_anything_measured(self):
        # Every stop here sits at the same single frame, so there is no worst
        # one. Any other order would invent a ranking out of a tie.
        records = self.records()

        self.assertEqual([r["name"] for r in records],
                         ["Adelaide St E", "Zoo Rd at Meadowvale"])

    def test_coordinates_survive_as_numbers(self):
        records = self.records()

        self.assertAlmostEqual(records[0]["lon"], -79.3)
        self.assertAlmostEqual(records[0]["lat"], 43.6)

    def test_ties_on_name_fall_back_to_id_so_the_order_is_stable(self):
        self.mask = np.array([True, True])
        self.names = ["Same Name", "Same Name"]
        self.ids = ["stop:22", "stop:3"]
        self.lons = [-79.1, -79.2]
        self.lats = [43.8, 43.7]

        records = self.records()

        self.assertEqual([r["id"] for r in records], ["stop:22", "stop:3"])


@unittest.skipUnless(os.path.exists(PUBLISHED_PATH),
                     "no-shade-stops.json has not been generated")
class PublishedSetTests(unittest.TestCase):
    """The shipped file against the proof file, which is the record."""

    @classmethod
    def setUpClass(cls):
        with open(PUBLISHED_PATH) as handle:
            cls.published = json.load(handle)
        with open(PROOF_PATH) as handle:
            cls.proof = json.load(handle)
        cls.expected = cls.proof[
            "transit_stops_no_usable_shade_both_surfaces"]

    def test_the_set_is_exactly_as_long_as_the_published_count(self):
        self.assertEqual(len(self.published["stops"]),
                         self.published["count"])

    def test_the_count_matches_the_proof_file(self):
        # Two answers to one question is the failure this guards. The proof
        # file is the record; the set may not quietly disagree with it.
        self.assertEqual(self.published["count"], self.expected["count"])
        self.assertEqual(self.published["ofTotal"], self.expected["of_total"])
        self.assertEqual(self.published["sharePercent"],
                         self.expected["share_percent"])

    def test_every_stop_is_named_and_placed(self):
        for stop in self.published["stops"]:
            self.assertTrue(stop["name"].strip(), stop)
            self.assertTrue(stop["id"].strip(), stop)
            self.assertIsInstance(stop["lon"], float)
            self.assertIsInstance(stop["lat"], float)

    def test_every_stop_lands_inside_Toronto(self):
        # A stop outside the city means the projection round trip is wrong,
        # which would put markers in the lake without failing anything else.
        for stop in self.published["stops"]:
            self.assertTrue(-79.7 < stop["lon"] < -79.1, stop)
            self.assertTrue(43.5 < stop["lat"] < 43.9, stop)

    def test_stop_ids_are_unique(self):
        ids = [stop["id"] for stop in self.published["stops"]]

        self.assertEqual(len(set(ids)), len(ids))

    def test_the_file_declares_that_its_order_carries_no_ranking(self):
        self.assertEqual(self.published["order"], "name")
        names = [stop["name"] for stop in self.published["stops"]]
        self.assertEqual(names, sorted(names))


if __name__ == "__main__":
    unittest.main()
