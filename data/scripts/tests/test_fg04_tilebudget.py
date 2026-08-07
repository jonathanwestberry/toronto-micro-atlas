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
        all_ground = np.ones((2, 2), dtype=bool)

        parent = pyramid.downsample_mask(child, all_ground)

        self.assertFalse(pyramid.hour_mask(parent, 13).any())

    def test_a_tie_counts_as_shaded(self):
        """Two of four. Stated here because a tie has to go somewhere."""
        child = np.zeros((2, 2), dtype=np.uint16)
        child[0, 0] = child[1, 1] = 1 << pyramid.hour_bit(13)
        all_ground = np.ones((2, 2), dtype=bool)

        parent = pyramid.downsample_mask(child, all_ground)

        self.assertTrue(pyramid.hour_mask(parent, 13).all())

    def test_only_ground_children_get_a_vote(self):
        """A roof has no shaded-hours count and must not dilute one."""
        child = np.zeros((2, 2), dtype=np.uint16)
        child[0, 0] = child[0, 1] = 1 << pyramid.hour_bit(13)
        half_is_ground = np.zeros((2, 2), dtype=bool)
        half_is_ground[0, :] = True

        parent = pyramid.downsample_mask(child, half_is_ground)

        self.assertTrue(pyramid.hour_mask(parent, 13).all())

    def test_one_ground_child_in_four_does_not_speak_for_the_parent(self):
        """Measured, not assumed, and it is the reason this rule exists.

        Letting one ground child of four carry a parent walked the mean from
        5.99 at z16 to 8.26 at z12. The blocks with the least ground are the
        tower districts, which are also the shadiest, so they gained weight
        at every level and dragged the whole city dark.
        """
        child = np.full((2, 2), pyramid.ALL_HOURS, dtype=np.uint16)
        only_one_is_ground = np.zeros((2, 2), dtype=bool)
        only_one_is_ground[0, 0] = True

        parent = pyramid.downsample_mask(child, only_one_is_ground)

        self.assertEqual(int(parent[0, 0]), 0)

    def test_a_parent_with_no_ground_children_is_empty(self):
        child = np.full((2, 2), pyramid.ALL_HOURS, dtype=np.uint16)
        no_ground = np.zeros((2, 2), dtype=bool)

        parent = pyramid.downsample_mask(child, no_ground)

        self.assertEqual(int(parent[0, 0]), 0)

    def test_averaging_ignores_pixels_that_are_not_ground(self):
        """Zero is "not ground", not "never shaded"."""
        counts = np.array([[8, 6], [0, 0]], dtype=np.uint16)

        self.assertEqual(int(pyramid.downsample_count(counts)[0, 0]), 7)

    def test_a_block_that_is_mostly_roof_is_not_ground_at_all(self):
        """One ground pixel of four does not describe the other three."""
        counts = np.array([[15, 0], [0, 0]], dtype=np.uint16)

        self.assertEqual(int(pyramid.downsample_count(counts)[0, 0]), 0)

    def test_a_block_with_no_ground_averages_to_zero(self):
        counts = np.zeros((2, 2), dtype=np.uint16)

        self.assertEqual(int(pyramid.downsample_count(counts)[0, 0]), 0)

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


class CountAggregationTests(unittest.TestCase):
    """The count must not drift as the reader zooms out.

    Majority vote with ties up walked the mean from 3.50 at z16 to 4.89 at
    z12 on the real pyramid, a 40% inflation, which would have put the map
    40% shadier than the figures printed beside it.
    """

    def test_averaging_four_children_is_their_mean(self):
        counts = np.array([[4, 6], [8, 10]], dtype=np.uint16)

        parent = pyramid.downsample_count(counts)

        self.assertEqual(parent.shape, (1, 1))
        self.assertEqual(int(parent[0, 0]), 7)

    def test_a_tie_rounds_to_even_rather_than_always_up(self):
        """Always-up adds a quarter frame per level. Four levels is a frame."""
        up = np.array([[6, 7], [6, 7]], dtype=np.uint16)      # mean 6.5 -> 6
        down = np.array([[7, 8], [7, 8]], dtype=np.uint16)    # mean 7.5 -> 8

        self.assertEqual(int(pyramid.downsample_count(up)[0, 0]), 6)
        self.assertEqual(int(pyramid.downsample_count(down)[0, 0]), 8)

    def test_the_mean_survives_four_levels_of_aggregation(self):
        rng = np.random.default_rng(11)
        counts = rng.integers(1, 16, size=(64, 64)).astype(np.uint16)
        before = counts.mean()

        for _ in range(4):
            counts = pyramid.downsample_count(counts).astype(np.uint16)

        self.assertAlmostEqual(float(counts.mean()), float(before), delta=0.3)

    def test_the_population_count_of_a_voted_mask_does_drift(self):
        """Why the count channel is not the mask's population count."""
        rng = np.random.default_rng(5)
        bits = rng.integers(0, pyramid.ALL_HOURS + 1,
                            size=(16, 16)).astype(np.uint16)
        before = pyramid.shaded_hours(bits).mean()

        voted = bits
        for _ in range(4):
            voted = pyramid.downsample_mask(voted)

        self.assertGreater(pyramid.shaded_hours(voted).mean(), before)

    def test_averaging_refuses_an_odd_tile(self):
        with self.assertRaises(ValueError):
            pyramid.downsample_count(np.zeros((3, 4), dtype=np.uint16))

    def test_a_count_above_the_frame_total_is_refused(self):
        bits = np.zeros((2, 2), dtype=np.uint16)

        with self.assertRaises(ValueError):
            pyramid.encode_tile(bits, np.full((2, 2), 16, dtype=np.uint8))

    def test_a_count_of_the_wrong_shape_is_refused(self):
        bits = np.zeros((2, 2), dtype=np.uint16)

        with self.assertRaises(ValueError):
            pyramid.encode_tile(bits, np.zeros((4, 4), dtype=np.uint8))


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
        self.assertNotRegex(
            entry["dawnNote"],
            r"\bdegrees\b",
            "The manifest note is inserted into the live legend. Use the "
            "degree symbol so a sun angle cannot read as a temperature.",
        )
        self.assertIn("0.38°", entry["dawnNote"])

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

    def test_the_manifest_carries_the_unpack_the_map_reads_with(self):
        entry = self.manifest()

        self.assertEqual(entry["demUnpack"], pyramid.DEM_UNPACK)
        self.assertEqual(entry["countChannel"], "red")

    def test_the_manifest_carries_a_band_start_for_every_count(self):
        entry = self.manifest()

        starts = entry["countBandStarts"]
        # 0 to 15 are the band floors; 16 is the edge above the top band, and
        # without it the highest band has no upper bound to interpolate to.
        self.assertEqual(len(starts), pyramid.MAX_BIT + 3)
        for count in range(pyramid.MAX_BIT + 3):
            self.assertEqual(starts[str(count)], pyramid.dem_value(count))
        self.assertIn("16", starts)

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
