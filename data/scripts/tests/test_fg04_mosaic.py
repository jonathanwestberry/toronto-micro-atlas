"""The windowed build must not re-read a tile once per window.

The 2 m citywide run took 3.69 hours and `rasterio.merge` was roughly 1,000
of each window's 1,200 seconds. The cause is window overlap: each 8 km
window carries a shadow margin, so adjacent windows re-read the same tiles.
About 5,700 tile reads landed on 1,454 distinct tiles, so every tile was
decompressed about 3.9 times, each read inflating a 16 MB float32 GeoTIFF
and resampling 0.5 m to 2 m.

These tests pin the property that fixes it: source tiles are read once, into
one mosaic per surface, and every window comes out of that mosaic. They also
pin the thing that matters more than speed, that the numbers do not move.
"""

import collections
import os
import tempfile
import unittest

import numpy as np
import rasterio
from rasterio.merge import merge

import fg04_mosaic as mosaic

CRS = "EPSG:6660"
TILE_M = 100.0          # a small stand-in for the real 1 km tile
NATIVE_RES = 0.5
TARGET_RES = 2.0
DSM_NODATA = -3.4028234663852886e+38     # the sentinel the real DSM carries
DTM_NODATA = 3.3999999521443642e+38      # and the one the real DTM carries


def write_tile(path, left, bottom, values, nodata):
    size = values.shape[0]
    transform = rasterio.transform.from_origin(
        left, bottom + TILE_M, NATIVE_RES, NATIVE_RES)
    profile = dict(driver="GTiff", width=size, height=size, count=1,
                   dtype="float32", crs=CRS, transform=transform,
                   nodata=nodata, compress="deflate", predictor=2,
                   tiled=True, blockxsize=128, blockysize=128)
    with rasterio.open(path, "w", **profile) as sink:
        sink.write(values.astype("float32"), 1)


def tile_grid(folder, across, base, nodata, hole=None):
    """A square grid of tiles, each carrying a distinct recognisable ramp."""
    os.makedirs(folder, exist_ok=True)
    size = int(TILE_M / NATIVE_RES)
    for row in range(across):
        for col in range(across):
            if hole is not None and (row, col) == hole:
                continue
            rows, cols = np.mgrid[0:size, 0:size]
            values = (base + (row * across + col) * 10.0
                      + rows * 0.001 + cols * 0.002)
            write_tile(
                os.path.join(folder, f"tile_{row}_{col}.tif"),
                left=1000.0 + col * TILE_M,
                bottom=2000.0 + row * TILE_M,
                values=values.astype("float32"),
                nodata=nodata,
            )


class CountingOpener:
    """Stands in for `rasterio.open` and remembers what was opened."""

    def __init__(self):
        self.opens = collections.Counter()

    def __call__(self, path, *args, **kwargs):
        self.opens[os.path.basename(str(path))] += 1
        return rasterio.open(path, *args, **kwargs)

    def source_opens(self):
        return {name: count for name, count in self.opens.items()
                if name.startswith("tile_")}


def overlapping_windows(count):
    """Windows that share ground, the way a padded 8 km window does."""
    windows = []
    step = TILE_M
    pad = TILE_M * 0.6
    for n in range(count):
        left = 1000.0 + n * step
        windows.append((left - pad, 2000.0 - pad,
                        left + step + pad, 2100.0 + pad))
    return windows


class SourceReadCountTests(unittest.TestCase):
    """The fix itself: reads per tile must not scale with window count."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dsm = os.path.join(self.tmp.name, "dsm")
        tile_grid(self.dsm, across=3, base=100.0, nodata=DSM_NODATA)
        self.addCleanup(self.tmp.cleanup)

    def test_every_source_tile_is_read_exactly_once_into_the_mosaic(self):
        index = mosaic.tile_index(self.dsm)
        opener = CountingOpener()

        mosaic.build_mosaic(index, mosaic.union_bounds(index), TARGET_RES,
                            os.path.join(self.tmp.name, "dsm-2m.tif"),
                            opener=opener)

        self.assertEqual(len(index), 9)
        self.assertEqual(set(opener.source_opens().values()), {1})

    def test_reading_windows_never_touches_a_source_tile(self):
        index = mosaic.tile_index(self.dsm)
        path = os.path.join(self.tmp.name, "dsm-2m.tif")
        mosaic.build_mosaic(index, mosaic.union_bounds(index), TARGET_RES, path)
        opener = CountingOpener()

        for bounds in overlapping_windows(6):
            mosaic.read_window(path, bounds, TARGET_RES, opener=opener)

        self.assertEqual(opener.source_opens(), {})

    def test_source_reads_do_not_grow_with_the_number_of_windows(self):
        index = mosaic.tile_index(self.dsm)
        counts = []
        for window_count in (2, 12):
            opener = CountingOpener()
            path = os.path.join(self.tmp.name, f"dsm-{window_count}.tif")
            mosaic.build_mosaic(index, mosaic.union_bounds(index), TARGET_RES,
                                path, opener=opener)
            for bounds in overlapping_windows(window_count):
                mosaic.read_window(path, bounds, TARGET_RES, opener=opener)
            counts.append(sum(opener.source_opens().values()))

        self.assertEqual(counts[0], counts[1])
        self.assertEqual(counts[0], len(index))

    def test_the_old_per_window_merge_reads_the_same_tile_repeatedly(self):
        """Why this task exists, measured rather than asserted from memory."""
        index = mosaic.tile_index(self.dsm)

        reads = collections.Counter()
        for bounds in overlapping_windows(6):
            for path in mosaic.intersecting(index, bounds):
                reads[os.path.basename(path)] += 1

        self.assertGreater(max(reads.values()), 1)
        self.assertGreater(sum(reads.values()), len(index))


class MosaicMatchesMergeTests(unittest.TestCase):
    """A faster path that changes a published number is a failed task."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dsm = os.path.join(self.tmp.name, "dsm")
        tile_grid(self.dsm, across=3, base=100.0, nodata=DSM_NODATA)
        self.index = mosaic.tile_index(self.dsm)
        self.path = os.path.join(self.tmp.name, "dsm-2m.tif")
        mosaic.build_mosaic(self.index, mosaic.union_bounds(self.index),
                            TARGET_RES, self.path)
        self.addCleanup(self.tmp.cleanup)

    def merged(self, bounds):
        paths = mosaic.intersecting(self.index, bounds)
        array, transform = merge(paths, bounds=mosaic.snap(bounds, TARGET_RES),
                                 res=TARGET_RES, nodata=mosaic.FILL)
        return array[0], transform

    def test_a_window_matches_what_rasterio_merge_would_have_returned(self):
        for bounds in overlapping_windows(4):
            with self.subTest(bounds=bounds):
                expected, expected_transform = self.merged(bounds)
                got, got_transform = mosaic.read_window(
                    self.path, bounds, TARGET_RES)

                self.assertEqual(got.shape, expected.shape)
                self.assertEqual(tuple(got_transform)[:6],
                                 tuple(expected_transform)[:6])
                np.testing.assert_allclose(got, expected, rtol=0, atol=0)

    def test_a_full_city_read_matches_merge(self):
        bounds = mosaic.union_bounds(self.index)
        expected, _ = self.merged(bounds)

        got, _ = mosaic.read_window(self.path, bounds, TARGET_RES)

        np.testing.assert_allclose(got, expected, rtol=0, atol=0)

    def test_overlapping_windows_agree_on_the_ground_they_share(self):
        left = mosaic.read_window(self.path, (1050.0, 2050.0, 1250.0, 2250.0),
                                  TARGET_RES)[0]
        right = mosaic.read_window(self.path, (1150.0, 2050.0, 1350.0, 2250.0),
                                   TARGET_RES)[0]

        shared_width = int(100.0 / TARGET_RES)
        np.testing.assert_array_equal(left[:, -shared_width:],
                                      right[:, :shared_width])


class NodataTests(unittest.TestCase):
    """Float32-extreme sentinels must never reach the height arithmetic."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dsm = os.path.join(self.tmp.name, "dsm")
        self.dtm = os.path.join(self.tmp.name, "dtm")
        tile_grid(self.dsm, across=2, base=100.0, nodata=DSM_NODATA,
                  hole=(1, 1))
        tile_grid(self.dtm, across=2, base=80.0, nodata=DTM_NODATA)
        self.addCleanup(self.tmp.cleanup)

    def build(self):
        dsm_index = mosaic.tile_index(self.dsm)
        dtm_index = mosaic.tile_index(self.dtm)
        bounds = mosaic.union_bounds(dtm_index)
        dsm_path = os.path.join(self.tmp.name, "dsm-2m.tif")
        dtm_path = os.path.join(self.tmp.name, "dtm-2m.tif")
        mosaic.build_mosaic(dsm_index, bounds, TARGET_RES, dsm_path)
        mosaic.build_mosaic(dtm_index, bounds, TARGET_RES, dtm_path)
        return dsm_path, dtm_path, bounds

    def test_a_gap_in_coverage_reads_as_fill_not_as_a_huge_number(self):
        dsm_path, _, bounds = self.build()

        array, _ = mosaic.read_window(dsm_path, bounds, TARGET_RES)

        self.assertTrue((array == mosaic.FILL).any())
        self.assertFalse(mosaic.real(array).all())
        self.assertLess(float(array.max()), 1e6)

    def test_normalised_zeroes_height_wherever_either_surface_is_missing(self):
        dsm_path, dtm_path, bounds = self.build()

        height, _, valid = mosaic.normalised_window(
            dsm_path, dtm_path, bounds, TARGET_RES)

        self.assertEqual(height.dtype, np.dtype("float32"))
        self.assertTrue((height[~valid] == 0.0).all())
        self.assertTrue(valid.any())
        self.assertFalse(valid.all())

    def test_normalised_is_the_dsm_minus_the_dtm_where_both_are_real(self):
        dsm_path, dtm_path, bounds = self.build()

        height, _, valid = mosaic.normalised_window(
            dsm_path, dtm_path, bounds, TARGET_RES)
        dsm, _ = mosaic.read_window(dsm_path, bounds, TARGET_RES)
        dtm, _ = mosaic.read_window(dtm_path, bounds, TARGET_RES)

        expected = np.clip((dsm - dtm)[valid], 0.0, mosaic.MAX_HEIGHT_M)
        np.testing.assert_allclose(height[valid], expected, rtol=0, atol=1e-4)

    def test_height_is_clipped_to_the_ceiling(self):
        dsm_path, dtm_path, bounds = self.build()

        height, _, _ = mosaic.normalised_window(
            dsm_path, dtm_path, bounds, TARGET_RES)

        self.assertLessEqual(float(height.max()), mosaic.MAX_HEIGHT_M)
        self.assertGreaterEqual(float(height.min()), 0.0)


class PartialCoverageTests(unittest.TestCase):
    """Bounds smaller than the tiles that touch them.

    The citywide build asks for the union of every tile, so nothing ever
    hangs over the edge. Anything that mosaics a sub-region does have tiles
    hanging over, and merge handles it by intersecting source bounds with
    the target before reading.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dsm = os.path.join(self.tmp.name, "dsm")
        tile_grid(self.dsm, across=3, base=100.0, nodata=DSM_NODATA)
        self.index = mosaic.tile_index(self.dsm)
        # Half a tile in from each edge, so every edge tile overhangs.
        full = mosaic.union_bounds(self.index)
        self.bounds = (full[0] + TILE_M / 2, full[1] + TILE_M / 2,
                       full[2] - TILE_M / 2, full[3] - TILE_M / 2)
        self.path = os.path.join(self.tmp.name, "dsm-2m.tif")
        self.addCleanup(self.tmp.cleanup)

    def test_a_tile_hanging_over_the_edge_is_clipped_not_refused(self):
        mosaic.build_mosaic(self.index, self.bounds, TARGET_RES, self.path)

        array, _ = mosaic.read_window(self.path, self.bounds, TARGET_RES)

        self.assertFalse((array == mosaic.FILL).any())

    def test_a_clipped_mosaic_still_matches_merge(self):
        mosaic.build_mosaic(self.index, self.bounds, TARGET_RES, self.path)
        expected, expected_transform = merge(
            mosaic.intersecting(self.index, self.bounds),
            bounds=mosaic.snap(self.bounds, TARGET_RES), res=TARGET_RES,
            nodata=mosaic.FILL)

        got, got_transform = mosaic.read_window(self.path, self.bounds,
                                                TARGET_RES)

        self.assertEqual(tuple(got_transform)[:6],
                         tuple(expected_transform)[:6])
        np.testing.assert_allclose(got, expected[0], rtol=0, atol=0)

    def test_a_tile_entirely_outside_the_bounds_is_skipped(self):
        corner = (1000.0, 2000.0, 1000.0 + TILE_M, 2000.0 + TILE_M)

        mosaic.build_mosaic(self.index, corner, TARGET_RES, self.path)

        array, _ = mosaic.read_window(self.path, corner, TARGET_RES)
        self.assertEqual(array.shape,
                         (int(TILE_M / TARGET_RES), int(TILE_M / TARGET_RES)))
        self.assertFalse((array == mosaic.FILL).any())


class MosaicReuseTests(unittest.TestCase):
    """A built mosaic is reused, and a stale one is not."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dsm = os.path.join(self.tmp.name, "dsm")
        tile_grid(self.dsm, across=2, base=100.0, nodata=DSM_NODATA)
        self.index = mosaic.tile_index(self.dsm)
        self.bounds = mosaic.union_bounds(self.index)
        self.path = os.path.join(self.tmp.name, "dsm-2m.tif")
        self.addCleanup(self.tmp.cleanup)

    def test_a_matching_mosaic_is_reused_without_reading_the_tiles(self):
        mosaic.ensure_mosaic(self.index, self.bounds, TARGET_RES, self.path)
        opener = CountingOpener()

        mosaic.ensure_mosaic(self.index, self.bounds, TARGET_RES, self.path,
                             opener=opener)

        self.assertEqual(opener.source_opens(), {})

    def test_a_mosaic_on_the_wrong_grid_is_rebuilt(self):
        mosaic.ensure_mosaic(self.index, self.bounds, TARGET_RES, self.path)
        opener = CountingOpener()

        mosaic.ensure_mosaic(self.index, self.bounds, 1.0, self.path,
                             opener=opener)

        self.assertEqual(set(opener.source_opens().values()), {1})
        with rasterio.open(self.path) as src:
            self.assertEqual(src.res, (1.0, 1.0))


if __name__ == "__main__":
    unittest.main()
