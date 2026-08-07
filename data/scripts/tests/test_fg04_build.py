"""The build script's date and hour selection.

`31_build_shade.py` writes the rasters every published figure is measured
from. Chapter six needed one more run against a winter sun, and the danger
in adding that is not the winter run: it is the winter run overwriting July.
These tests exist to hold the default path fixed.
"""
import importlib.util
import os
import unittest
from pathlib import Path

import numpy as np
from affine import Affine

import fg04_solar as solar

PROCESSED = Path(__file__).parents[2] / "processed" / "fg04"

SCRIPT_PATH = Path(__file__).parents[1] / "31_build_shade.py"


def load_builder():
    spec = importlib.util.spec_from_file_location("fg04_builder", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OutputNamingTests(unittest.TestCase):
    """The July artifacts are published. Nothing may land on top of them."""

    def setUp(self):
        self.build = load_builder()

    def test_the_july_run_writes_the_names_the_guide_already_uses(self):
        tag = self.build.output_tag(solar.MODEL_DATE, None)

        self.assertEqual(tag, "")
        self.assertEqual(self.build.output_name("shade-raw", tag),
                         "shade-raw.tif")
        self.assertEqual(self.build.output_name("ground", tag), "ground.tif")

    def test_a_winter_run_cannot_land_on_a_july_artifact(self):
        tag = self.build.output_tag(solar.WINTER_DATE, [12])

        for stem in ("shade-raw", "shade-corrected", "ground"):
            july = self.build.output_name(stem, "")
            winter = self.build.output_name(stem, tag)
            self.assertNotEqual(july, winter)
            self.assertTrue(winter.startswith(stem))
            self.assertTrue(winter.endswith(".tif"))

    def test_the_tag_names_the_date_and_the_hours(self):
        tag = self.build.output_tag(solar.WINTER_DATE, [12])

        self.assertIn("2026-01-21", tag)
        self.assertIn("12", tag)

    def test_a_july_run_of_selected_hours_is_still_tagged(self):
        """Selecting hours changes the bit positions, so it is not July."""
        tag = self.build.output_tag(solar.MODEL_DATE, [13])

        self.assertNotEqual(tag, "")

    def test_the_correction_report_is_tagged_too(self):
        tag = self.build.output_tag(solar.WINTER_DATE, [12])

        self.assertEqual(self.build.report_name(""), "correction-report.json")
        self.assertNotEqual(self.build.report_name(tag),
                            "correction-report.json")


class FrameSelectionTests(unittest.TestCase):
    def setUp(self):
        self.build = load_builder()

    def test_no_selection_keeps_every_daylight_frame(self):
        frames = solar.hourly_frames(solar.MODEL_DATE)

        self.assertEqual(self.build.select_frames(frames, None), frames)

    def test_selecting_the_winter_noon_hour_leaves_one_frame(self):
        frames = solar.hourly_frames(solar.WINTER_DATE)

        chosen = self.build.select_frames(frames, [12])

        self.assertEqual(len(chosen), 1)
        self.assertEqual(chosen[0].clock.hour, 12)

    def test_selecting_an_hour_the_sun_is_down_is_an_error(self):
        """06:00 exists in July and not in January. Silence would be worse."""
        frames = solar.hourly_frames(solar.WINTER_DATE)

        with self.assertRaises(SystemExit):
            self.build.select_frames(frames, [6])

    def test_selection_preserves_order_so_bit_positions_are_stable(self):
        frames = solar.hourly_frames(solar.MODEL_DATE)

        chosen = self.build.select_frames(frames, [16, 9, 13])

        self.assertEqual([f.clock.hour for f in chosen], [9, 13, 16])


class CoreBlockTests(unittest.TestCase):
    """Cutting the core window out of a padded, trimmed array.

    This is where the build put every window one pixel out of place. The old
    code removed `round(trim) + round(margin_px)` pixels, two separately
    rounded halves of a buffer whose true width in pixels is fractional, and
    `snap` had already floored the padded edge to a whole pixel. The two
    disagreed by one whenever the fractional parts fell the wrong way, so
    fourteen of the city's nineteen covered windows were written 2 m
    south-east of where they belong and five were correct. Nothing raised.
    The rasters looked fine; adjacent windows simply disagreed by a pixel.

    The cure is to stop doing arithmetic on buffers and read the offset off
    the array's own georeference, which is exact by construction.
    """

    def setUp(self):
        self.build = load_builder()

    @staticmethod
    def padded_grid(core, buffer_m, res):
        """The grid 31_build_shade actually reads, snap and all."""
        import fg04_mosaic as mosaic
        left, bottom, right, top = mosaic.snap(
            (core[0] - buffer_m, core[1] - buffer_m,
             core[2] + buffer_m, core[3] + buffer_m), res)
        width = int(round((right - left) / res))
        height = int(round((top - bottom) / res))
        return Affine.translation(left, top) * Affine.scale(res, -res), \
            height, width

    def test_the_core_lands_where_its_coordinates_say(self):
        res = 2.0
        core = (630000.0, 4830000.0, 638000.0, 4838000.0)
        transform, height, width = self.padded_grid(core, 4390.2, res)

        # A ramp whose value encodes its own position, so a shift shows up.
        data = (np.arange(height)[:, None] * 100000
                + np.arange(width)[None, :]).astype(np.int64)

        block = self.build.core_block(data, transform, core, res)

        row, col = ~transform * (core[0], core[3])
        self.assertEqual(block[0, 0],
                         int(round(col)) * 1 + int(round(row)) * 100000)
        self.assertEqual(block.shape, (4000, 4000))

    def test_the_exact_offset_the_old_arithmetic_got_wrong(self):
        """worst_buffer 4390.2 m is 2195.10 px; snap floors the edge to 2196.

        The old path removed round(230.5) + round(1964.6) = 2195. One short.
        """
        import fg04_mosaic as mosaic

        res, buffer_m = 2.0, 4390.2
        core = (630000.0, 4830000.0, 638000.0, 4838000.0)
        padded = mosaic.snap((core[0] - buffer_m, core[1] - buffer_m,
                              core[2] + buffer_m, core[3] + buffer_m), res)

        needed = (core[0] - padded[0]) / res
        margin_m = 3929.2
        old = (int(round((buffer_m - margin_m) / res))
               + int(round(margin_m / res)))

        self.assertEqual(needed, 2196.0)
        self.assertEqual(old, 2195)          # the defect, pinned
        transform, height, width = self.padded_grid(core, buffer_m, res)
        data = np.arange(height * width).reshape(height, width)
        block = self.build.core_block(data, transform, core, res)
        self.assertEqual(block[0, 0], 2196 * width + 2196)

    def test_every_margin_lands_on_the_same_grid(self):
        """The seam test: the offset must not depend on the local maximum.

        Fourteen windows shifted and five did not, because the margin is
        sized from the tallest object near each window. Whatever the margin,
        the core must come out at the same coordinates.
        """
        res = 2.0
        core = (630000.0, 4830000.0, 638000.0, 4838000.0)
        transform, height, width = self.padded_grid(core, 4390.2, res)
        data = (np.arange(height)[:, None] * 100000
                + np.arange(width)[None, :]).astype(np.int64)

        corners = set()
        for trim in (0, 1, 230, 1415, 1686, 1947):
            trimmed = data[trim:height - trim, trim:width - trim]
            moved = transform * Affine.translation(trim, trim)
            block = self.build.core_block(trimmed, moved, core, res)
            corners.add(int(block[0, 0]))

        self.assertEqual(len(corners), 1)

    def test_a_core_outside_the_array_is_an_error_not_a_short_block(self):
        res = 2.0
        core = (630000.0, 4830000.0, 638000.0, 4838000.0)
        transform, height, width = self.padded_grid(core, 4390.2, res)
        data = np.zeros((height, width), dtype=np.uint8)
        far = (core[0] + 40000.0, core[1], core[2] + 40000.0, core[3])

        with self.assertRaises(ValueError):
            self.build.core_block(data, transform, far, res)


class WinterBudgetTests(unittest.TestCase):
    """Why the whole winter day is not computed, kept as a number.

    Measured, not argued: the recorded July run is 13,273.2 s over 24
    windows. The winter day's lowest casting frame demands a 19,890 m margin
    against July's 4,390, which is a 10 GB window read on a 16 GB machine and
    a modelled 171 h. The noon frame alone needs 1,217 m.
    """

    def setUp(self):
        self.build = load_builder()

    def test_the_whole_winter_day_does_not_fit_this_machine(self):
        import fg04_shadow as shadow

        frames = solar.hourly_frames(solar.WINTER_DATE)
        lowest = min(f.altitude for f in frames
                     if f.altitude > shadow.HORIZON_DEG)
        buffer_m = shadow.required_buffer(self.build.MAX_HEIGHT_M, lowest)
        side_px = (self.build.WINDOW_M + 2 * buffer_m) / 2.0

        self.assertGreater(buffer_m, 19_000.0)
        self.assertGreater(side_px ** 2 * 4 / 1024 ** 3, 2.0)

    def test_the_winter_noon_frame_does(self):
        import fg04_shadow as shadow

        frame = solar.frame_nearest_solar_noon(solar.WINTER_DATE)
        buffer_m = shadow.required_buffer(self.build.MAX_HEIGHT_M,
                                          frame.altitude)
        side_px = (self.build.WINDOW_M + 2 * buffer_m) / 2.0

        self.assertLess(buffer_m, 1_500.0)
        self.assertLess(side_px ** 2 * 4 / 1024 ** 3, 0.2)


class CitywideRegistrationTests(unittest.TestCase):
    """The defect was in the composition, so the guard has to be too.

    `core_block` is unit tested, but the bug that shipped was not a wrong
    function: it was two correct roundings that disagreed once the buffers,
    the snap and the trim were composed. Only a whole-raster check catches
    that class of thing coming back.

    Ground is DSM minus DTM under 2 m. It does not depend on the sun, so it
    can be recomputed from the mosaic over each window's exact bounds and
    must match the raster the build wrote, at zero offset, everywhere.
    """

    RESOLUTION = 2.0
    WINDOW_M = 8000.0
    GROUND_MAX_M = 2.0

    @unittest.skipUnless(
        (PROCESSED / "ground.tif").exists()
        and (PROCESSED / "mosaic-dsm-2m.tif").exists(),
        "the citywide rasters are gitignored; run 31_build_shade.py")
    def test_every_window_sits_where_its_coordinates_say(self):
        import rasterio

        import fg04_mosaic as mosaic

        build = load_builder()
        index = mosaic.tile_index(str(PROCESSED.parents[1] / "raw" / "fg04"
                                      / "dsm"))
        city = mosaic.snap(mosaic.union_bounds(index), self.RESOLUTION)
        left, bottom, right, top = city
        cores = [(x, y, min(x + self.WINDOW_M, right),
                  min(y + self.WINDOW_M, top))
                 for y in np.arange(bottom, top, self.WINDOW_M)
                 for x in np.arange(left, right, self.WINDOW_M)]

        checked = 0
        with rasterio.open(PROCESSED / "ground.tif") as written:
            for number, core in enumerate(cores, start=1):
                height, _, valid = mosaic.normalised_window(
                    str(PROCESSED / "mosaic-dsm-2m.tif"),
                    str(PROCESSED / "mosaic-dtm-2m.tif"),
                    mosaic.snap(core, self.RESOLUTION), self.RESOLUTION)
                if not valid.any():
                    continue
                truth = ((height < self.GROUND_MAX_M) & valid).astype("uint8")

                window = build.from_bounds(*core, written.transform)
                window = rasterio.windows.Window(
                    int(round(window.col_off)), int(round(window.row_off)),
                    int(round(window.width)), int(round(window.height)))
                got = written.read(1, window=window)
                rows = min(truth.shape[0], got.shape[0])
                cols = min(truth.shape[1], got.shape[1])

                with self.subTest(window=number):
                    mismatch = (truth[:rows, :cols] != got[:rows, :cols]).mean()
                    self.assertEqual(
                        mismatch, 0.0,
                        f"window {number} disagrees with its own coordinates "
                        f"on {mismatch * 100:.2f}% of pixels; the build is "
                        f"writing blocks off-grid again")
                checked += 1
        self.assertGreater(checked, 15, "expected most windows to be covered")
