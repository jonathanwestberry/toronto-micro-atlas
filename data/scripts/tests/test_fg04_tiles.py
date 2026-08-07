import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

import geopandas as gpd
import numpy as np
from shapely.geometry import Polygon

from fg04_tiles import dtm_name, packages_needed, tiles_for_boundary


def square(x, y, size=1.0):
    return Polygon([(x, y), (x + size, y), (x + size, y + size), (x, y + size)])


def index_frame():
    return gpd.GeoDataFrame(
        {
            "FileName": ["inside_DSM.tif", "outside_DSM.tif", "wrongproj_DSM.tif"],
            "Package": ["GTA2023-DSM-05", "GTA2023-DSM-05", "GTA2023-DSM-09"],
            "Project": ["GTA 2023", "GTA 2023", "GTA 2015"],
            "geometry": [square(0, 0), square(50, 50), square(0, 0)],
        },
        crs="EPSG:4326",
    )


class TileSelectionTests(unittest.TestCase):
    def test_keeps_only_tiles_touching_the_boundary(self):
        boundary = gpd.GeoDataFrame(
            {"geometry": [square(0.2, 0.2, 0.5)]}, crs="EPSG:4326")

        selected = tiles_for_boundary(index_frame(), boundary, project="GTA 2023")

        self.assertEqual(list(selected["FileName"]), ["inside_DSM.tif"])

    def test_ignores_other_lidar_projects_over_the_same_ground(self):
        boundary = gpd.GeoDataFrame(
            {"geometry": [square(0.2, 0.2, 0.5)]}, crs="EPSG:4326")

        selected = tiles_for_boundary(index_frame(), boundary, project="GTA 2015")

        self.assertEqual(list(selected["FileName"]), ["wrongproj_DSM.tif"])

    def test_counts_tiles_per_package(self):
        boundary = gpd.GeoDataFrame(
            {"geometry": [square(-1, -1, 100)]}, crs="EPSG:4326")

        selected = tiles_for_boundary(index_frame(), boundary, project="GTA 2023")

        self.assertEqual(packages_needed(selected), {"GTA2023-DSM-05": 2})

    def test_dtm_name_mirrors_the_dsm_name(self):
        self.assertEqual(
            dtm_name("1km176300483402023LGTA2023_DSM.tif"),
            "1km176300483402023LGTA2023_DTM.tif",
        )

    def test_dtm_name_rejects_a_name_that_is_not_a_dsm_tile(self):
        with self.assertRaises(ValueError):
            dtm_name("something_else.tif")


SCRIPT = Path(__file__).parents[1] / "33_fg04_tiles.py"
SPEC = importlib.util.spec_from_file_location("fg04_tiles_script", SCRIPT)
tiles = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tiles)


class DerivedRasterFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def file_at(self, name, modified):
        path = self.root / name
        path.touch()
        os.utime(path, (modified, modified))
        return str(path)

    def test_missing_derivative_is_not_current(self):
        source = self.file_at("source.tif", 100)

        self.assertFalse(
            tiles.derived_is_current(str(self.root / "missing.tif"), [source]))

    def test_derivative_newer_than_every_source_is_current(self):
        sources = [self.file_at("shade.tif", 100),
                   self.file_at("ground.tif", 101)]
        derivative = self.file_at("count.tif", 102)

        self.assertTrue(tiles.derived_is_current(derivative, sources))

    def test_derivative_older_than_one_source_is_stale(self):
        sources = [self.file_at("shade.tif", 100),
                   self.file_at("ground.tif", 103)]
        derivative = self.file_at("count.tif", 102)

        self.assertFalse(tiles.derived_is_current(derivative, sources))


class CountValueTests(unittest.TestCase):
    def test_counts_only_ground_pixels(self):
        bits = np.array([[0b1, 0b11], [0b111, 0]], dtype=np.uint16)
        ground = np.array([[True, True], [True, False]])

        values = tiles.count_values(bits, ground)

        np.testing.assert_array_equal(values, [[1, 2], [3, 0]])

    def test_corrected_ground_under_canopy_is_shaded_in_all_frames(self):
        bits = np.array([[0b1, 0b11], [0b111, 0]], dtype=np.uint16)
        ground = np.array([[True, True], [True, False]])
        under_canopy = np.array([[False, True], [False, True]])

        values = tiles.count_values(bits, ground, under_canopy=under_canopy)

        np.testing.assert_array_equal(values, [[1, 15], [3, 0]])


if __name__ == "__main__":
    unittest.main()
