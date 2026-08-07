"""The file-count gate, and the pyramid it guards.

Cloudflare Pages refuses a deployment over **20,000 files** and a file over
**25 MiB**. Neither limit is npm's, so neither shows up in CI: a pyramid that
breaks the deployment passes every test the repo has and then fails at the
edge, after the merge, with the guide already announced.

So the count is a gate *before* generation and again at the end. z17 alone is
29,700 tiles over the lidar rectangle. z16 is the hard maximum, and if a later
phase wants more zoom the answer is R2 or a split PMTiles archive, not more
files.

The pyramid is also where the shade bitmask could quietly stop meaning what it
means. Aggregating a bitmask by picking one child pixel out of four is not
wrong so much as arbitrary; the parent is a majority vote per bit, so "shaded
at 13:00" at z12 means "most of this ground was shaded at 13:00" rather than
"one sampled pixel in 361 was".
"""

import json
import os
import tempfile
import unittest

import numpy as np

import fg04_pyramid as pyramid

# The lidar rectangle in WGS84, from the citywide raster's own bounds.
TORONTO = (-79.64998, 43.57148, -79.10860, 43.86705)


class TileCountTests(unittest.TestCase):
    """Counting before writing, because the limit is not npm's."""

    def test_the_zoom_ceiling_is_sixteen(self):
        self.assertEqual(pyramid.MAX_ZOOM, 16)
        self.assertEqual(pyramid.MIN_ZOOM, 12)

    def test_counts_rise_about_fourfold_per_zoom(self):
        counts = [pyramid.tile_count(TORONTO, z) for z in range(12, 17)]

        for shallower, deeper in zip(counts, counts[1:]):
            self.assertGreater(deeper, shallower * 3)
            self.assertLess(deeper, shallower * 5)

    def test_the_projection_matches_a_count_of_the_actual_tile_keys(self):
        for zoom in range(12, 17):
            with self.subTest(zoom=zoom):
                listed = len(list(pyramid.tiles_for_bounds(TORONTO, zoom)))
                self.assertEqual(listed, pyramid.tile_count(TORONTO, zoom))

    def test_the_projection_counts_a_file_per_surface(self):
        projected = pyramid.project_file_count(TORONTO)

        self.assertEqual(projected["total"],
                         projected["coordinates"] * len(pyramid.SURFACES))
        self.assertEqual(
            projected["total"],
            sum(projected[z] for z in range(pyramid.MIN_ZOOM,
                                            pyramid.MAX_ZOOM + 1)))

    def test_the_pyramid_no_longer_fits_a_pages_deployment(self):
        """Which is the whole reason it is on R2 and not in the site."""
        projected = pyramid.project_file_count(TORONTO)

        self.assertGreater(projected["total"] + 449,
                           pyramid.CLOUDFLARE_FILE_LIMIT)
        self.assertEqual(pyramid.HOSTING, "r2")

    def test_z17_is_why_the_ceiling_exists(self):
        """Recorded so the reason survives the person who found it."""
        seventeen = pyramid.tile_count(TORONTO, 17)

        self.assertGreater(seventeen, pyramid.CLOUDFLARE_FILE_LIMIT)


class FileBudgetGateTests(unittest.TestCase):
    """The gate refuses rather than warns."""

    def test_a_budget_that_fits_passes(self):
        pyramid.check_file_budget(projected=9000, existing=449)

    def test_a_budget_that_does_not_fit_is_refused_before_anything_is_written(self):
        with self.assertRaises(pyramid.FileBudgetError):
            pyramid.check_file_budget(projected=19_800, existing=449)

    def test_the_existing_site_counts_against_the_budget(self):
        """19,900 alone fits. With the built site it does not."""
        pyramid.check_file_budget(projected=19_900, existing=0)

        with self.assertRaises(pyramid.FileBudgetError):
            pyramid.check_file_budget(projected=19_900, existing=449)

    def test_the_error_says_what_to_do_about_it(self):
        with self.assertRaises(pyramid.FileBudgetError) as caught:
            pyramid.check_file_budget(projected=30_000, existing=449)

        message = str(caught.exception)
        self.assertIn("20,000", message)
        self.assertRegex(message, r"R2|PMTiles")

    def test_a_manifest_is_not_free_either(self):
        """The gate counts every file the pyramid adds, not only tiles."""
        at_limit = pyramid.CLOUDFLARE_FILE_LIMIT - 449

        pyramid.check_file_budget(projected=at_limit, existing=449)
        with self.assertRaises(pyramid.FileBudgetError):
            pyramid.check_file_budget(projected=at_limit + 1, existing=449)


class FileSizeGateTests(unittest.TestCase):
    """25 MiB per file, which a stacked tile has no business approaching."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_ordinary_tiles_pass(self):
        path = os.path.join(self.tmp.name, "small.png")
        with open(path, "wb") as handle:
            handle.write(b"\0" * 1024)

        pyramid.check_file_sizes([path])

    def test_a_file_over_the_limit_is_refused(self):
        path = os.path.join(self.tmp.name, "huge.bin")
        with open(path, "wb") as handle:
            handle.truncate(pyramid.CLOUDFLARE_MAX_FILE_BYTES + 1)

        with self.assertRaises(pyramid.FileBudgetError):
            pyramid.check_file_sizes([path])


class OverviewTests(unittest.TestCase):
    """A parent tile is a majority vote per bit, not a sampled child."""

    def test_four_shaded_children_make_a_shaded_parent(self):
        child = np.full((4, 4), 1 << pyramid.hour_bit(13), dtype=np.uint16)

        parent = pyramid.downsample_mask(child)

        self.assertEqual(parent.shape, (2, 2))
        self.assertTrue(pyramid.hour_mask(parent, 13).all())

    def test_one_shaded_child_in_four_does_not_carry_the_parent(self):
        child = np.zeros((2, 2), dtype=np.uint16)
        child[0, 0] = 1 << pyramid.hour_bit(13)

        parent = pyramid.downsample_mask(child)

        self.assertFalse(pyramid.hour_mask(parent, 13).any())

    def test_a_tie_counts_as_shaded(self):
        """Two of four. Stated here because a tie has to go somewhere."""
        child = np.zeros((2, 2), dtype=np.uint16)
        child[0, 0] = child[1, 1] = 1 << pyramid.hour_bit(13)

        parent = pyramid.downsample_mask(child)

        self.assertTrue(pyramid.hour_mask(parent, 13).all())

    def test_each_hour_is_voted_on_separately(self):
        child = np.zeros((2, 2), dtype=np.uint16)
        child[:, :] = 1 << pyramid.hour_bit(9)          # 9:00 everywhere
        child[0, 0] |= 1 << pyramid.hour_bit(17)        # 17:00 in one corner

        parent = pyramid.downsample_mask(child)

        self.assertTrue(pyramid.hour_mask(parent, 9).all())
        self.assertFalse(pyramid.hour_mask(parent, 17).any())

    def test_an_overview_never_invents_a_bit_above_fourteen(self):
        child = np.full((8, 8), pyramid.ALL_HOURS, dtype=np.uint16)

        parent = pyramid.downsample_mask(child)

        pyramid.check_bits(parent)
        self.assertEqual(int(parent.max()), pyramid.ALL_HOURS)

    def test_the_dawn_bit_survives_every_level_of_aggregation(self):
        """06:00 is set on every pixel, so it must be set on every parent."""
        bits = np.full((16, 16), 1 << pyramid.hour_bit(6), dtype=np.uint16)

        for _ in range(4):
            bits = pyramid.downsample_mask(bits)

        self.assertTrue(pyramid.hour_mask(bits, 6).all())


class ManifestTests(unittest.TestCase):
    """The legend and the layers read one manifest so they cannot disagree."""

    def manifest(self):
        return pyramid.manifest(bounds=TORONTO, tiles_written=5000,
                                projected=pyramid.project_file_count(TORONTO))

    def test_the_manifest_states_the_instrument(self):
        entry = self.manifest()

        self.assertEqual(entry["modelledDate"], "2026-07-21")
        self.assertEqual(entry["timezone"], "America/Toronto")
        self.assertEqual(entry["gridResolutionM"], 2.0)
        self.assertEqual(entry["flightSeason"], "April to May 2023")

    def test_the_manifest_carries_the_bit_mapping(self):
        entry = self.manifest()

        self.assertEqual({int(k): v for k, v in entry["hourBits"].items()},
                         pyramid.HOUR_BITS)
        self.assertEqual(entry["maxBit"], 14)

    def test_the_manifest_names_both_surfaces_in_words(self):
        entry = self.manifest()

        self.assertEqual(list(entry["surfaces"]), list(pyramid.SURFACES))
        for surface in pyramid.SURFACES:
            label = entry["surfaceLabels"][surface]
            self.assertTrue(label and not label.isspace(),
                            "colour alone must not carry which surface is "
                            "showing; every surface needs a label in words")

    def test_the_manifest_says_that_dawn_is_shaded_everywhere(self):
        entry = self.manifest()

        self.assertEqual(entry["dawnHour"], 6)
        self.assertRegex(entry["dawnNote"], r"shaded everywhere")

    def test_the_manifest_makes_no_thermal_claim(self):
        text = json.dumps(self.manifest()).lower()

        for word in ("cool", "heat", "hot", "warm", "temperature", "thermal"):
            self.assertNotIn(word, text,
                             "this guide maps shade, never temperature")

    def test_the_manifest_states_the_tile_format(self):
        entry = self.manifest()

        self.assertEqual(entry["format"], "webp")
        self.assertTrue(entry["lossless"])

    def test_the_manifest_carries_a_url_template_per_surface(self):
        entry = self.manifest()

        templates = entry["tileUrlTemplates"]
        self.assertEqual(set(templates), set(pyramid.SURFACES))
        for template in templates.values():
            for placeholder in ("{z}", "{x}", "{y}"):
                self.assertIn(placeholder, template)
            self.assertTrue(template.endswith(".webp"))

    def test_the_manifest_carries_the_dem_encoding_the_map_reads_with(self):
        entry = self.manifest()

        self.assertEqual(entry["demEncoding"]["encoding"], "custom")
        self.assertEqual(entry["demEncoding"]["blueFactor"], 1)

    def test_the_manifest_says_where_the_tiles_are_hosted(self):
        entry = self.manifest()

        self.assertIn(entry["hosting"], ("r2", "pages"))

    def test_the_zoom_range_and_the_native_zoom(self):
        entry = self.manifest()

        self.assertEqual(entry["minZoom"], pyramid.MIN_ZOOM)
        self.assertEqual(entry["maxZoom"], pyramid.MAX_ZOOM)
        self.assertEqual(entry["nativeZoom"], pyramid.MAX_ZOOM)

    def test_the_manifest_records_the_count_against_the_projection(self):
        entry = self.manifest()

        self.assertEqual(entry["tilesWritten"], 5000)
        self.assertEqual(entry["tilesProjected"],
                         pyramid.project_file_count(TORONTO)["total"])
        self.assertLessEqual(entry["tilesWritten"], entry["tilesProjected"])

    def test_the_manifest_is_json_serialisable(self):
        json.dumps(self.manifest())


if __name__ == "__main__":
    unittest.main()
