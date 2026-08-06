import unittest

import geopandas as gpd
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

        tiles = tiles_for_boundary(index_frame(), boundary, project="GTA 2023")

        self.assertEqual(list(tiles["FileName"]), ["inside_DSM.tif"])

    def test_ignores_other_lidar_projects_over_the_same_ground(self):
        boundary = gpd.GeoDataFrame(
            {"geometry": [square(0.2, 0.2, 0.5)]}, crs="EPSG:4326")

        tiles = tiles_for_boundary(index_frame(), boundary, project="GTA 2015")

        self.assertEqual(list(tiles["FileName"]), ["wrongproj_DSM.tif"])

    def test_counts_tiles_per_package(self):
        boundary = gpd.GeoDataFrame(
            {"geometry": [square(-1, -1, 100)]}, crs="EPSG:4326")

        tiles = tiles_for_boundary(index_frame(), boundary, project="GTA 2023")

        self.assertEqual(packages_needed(tiles), {"GTA2023-DSM-05": 2})

    def test_dtm_name_mirrors_the_dsm_name(self):
        self.assertEqual(
            dtm_name("1km176300483402023LGTA2023_DSM.tif"),
            "1km176300483402023LGTA2023_DTM.tif",
        )

    def test_dtm_name_rejects_a_name_that_is_not_a_dsm_tile(self):
        with self.assertRaises(ValueError):
            dtm_name("something_else.tif")
