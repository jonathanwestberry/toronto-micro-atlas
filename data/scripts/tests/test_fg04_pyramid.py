"""The shade tile encoding, pinned before any tile is written.

Phase 3 puts an hour slider on this map. Dragging it must be a bit test
against data already in the browser, never a fetch, because a fetch per hour
turns a slider into fifteen network round trips and the guide's whole
argument is what happens *between* hours. That is an architectural decision,
and this file is what stops it being quietly undone by a later change that
looks locally reasonable.

Five invariants, all from the Phase 2 plan:

  1. A tile is ONE raster carrying a per-pixel bitmask. Not one band per
     hour, not one file per hour.
  2. Bits 0 to 14 only. No bit above position 14 is ever set, on either
     surface. The citywide rasters already satisfy this and the pyramid may
     not break it.
  3. Hour n is recoverable by a bit test, and the clock-hour to bit-position
     mapping is asserted here rather than inferred at the call site.
  4. The 06:00 bit is set for every ground pixel, because that frame sits at
     0.38 degrees, at or below the model's horizon cutoff, and is shaded
     everywhere by construction.
  5. Both surfaces are present and separately addressable. Every lidar
     flight over Toronto is leaf-off, and the correction reverses which
     neighbourhoods are shadiest, so a reader who can see one surface must
     be able to see the other. That rule governs the map, not only the prose.

One invariant is not in the plan and is added because it is the way this
encoding fails silently in a browser: **no data in the alpha channel.**
Canvas stores pixels premultiplied and unpremultiplies them on read, so any
byte parked in alpha comes back rounded, and comes back destroyed where
alpha is zero. A bitmask that survives Python and corrupts in `getImageData`
would look like a rendering bug for a week.

Fifteen bits on two surfaces is thirty bits and RGB carries twenty-four, so
the two surfaces get **a square tile each** at the same coordinates under
different prefixes. Square matters: MapLibre colourises the count with a
`raster-dem` source and a `color-relief` layer, and a `raster-dem` source
cannot read a tile that is not square. Three channels:

    R  shaded-hours count, 0 to 15
    G  mask bits 8 to 14, top bit unused
    B  mask bits 0 to 7

B is derived from R and G and is redundant on purpose. The count layer is
what the reader sees first, and MapLibre reads B directly as the value its
colour ramp interpolates over. It is pinned here as equal to the population
count so the two can never drift.
"""

import os
import unittest

import numpy as np

import fg04_pyramid as pyramid
import fg04_solar as solar

HERE = os.path.dirname(os.path.abspath(__file__))
PROCESSED = os.path.abspath(
    os.path.join(HERE, "..", "..", "processed", "fg04"))

# The mapping, written out rather than generated, so that a change to the
# generator cannot quietly agree with itself.
EXPECTED_HOUR_BITS = {
    6: 0, 7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 13: 7,
    14: 8, 15: 9, 16: 10, 17: 11, 18: 12, 19: 13, 20: 14,
}


def sample_masks(height=8, width=8):
    """Two distinguishable surfaces with the dawn bit set on both."""
    rows, cols = np.mgrid[0:height, 0:width]
    raw = ((rows * width + cols) % 0x7FFF).astype(np.uint16)
    corrected = ((raw.astype(np.uint32) * 7 + 3) % 0x7FFF).astype(np.uint16)
    dawn = np.uint16(1 << EXPECTED_HOUR_BITS[6])
    return raw | dawn, corrected | dawn


class BitMappingTests(unittest.TestCase):
    """Hour to bit position, stated rather than inferred."""

    def test_the_mapping_is_exactly_the_modelled_day(self):
        self.assertEqual(pyramid.HOUR_BITS, EXPECTED_HOUR_BITS)

    def test_the_mapping_matches_the_order_the_frames_were_packed_in(self):
        frames = solar.hourly_frames()

        packed = {int(frame.clock.hour): position
                  for position, frame in enumerate(frames)}

        self.assertEqual(packed, EXPECTED_HOUR_BITS)

    def test_the_first_and_last_bits_are_the_first_and_last_frames(self):
        self.assertEqual(pyramid.hour_bit(solar.FIRST_HOUR), 0)
        self.assertEqual(pyramid.hour_bit(solar.LAST_HOUR), pyramid.MAX_BIT)

    def test_an_hour_outside_the_modelled_day_has_no_bit(self):
        for hour in (5, 21, 0, 23):
            with self.subTest(hour=hour), self.assertRaises(ValueError):
                pyramid.hour_bit(hour)

    def test_the_top_bit_is_fourteen_and_the_mask_is_fifteen_bits(self):
        self.assertEqual(pyramid.MAX_BIT, 14)
        self.assertEqual(pyramid.ALL_HOURS, 0x7FFF)
        self.assertEqual(len(pyramid.HOUR_BITS), 15)


class BitTestRecoveryTests(unittest.TestCase):
    """Reading an hour is a bit test, which is what makes the slider free."""

    def test_an_hour_is_recovered_by_testing_its_bit(self):
        raw, _ = sample_masks()

        for hour, position in EXPECTED_HOUR_BITS.items():
            with self.subTest(hour=hour):
                np.testing.assert_array_equal(
                    pyramid.hour_mask(raw, hour),
                    ((raw >> position) & 1).astype(bool))

    def test_setting_one_hour_leaves_every_other_hour_alone(self):
        bits = np.zeros((4, 4), dtype=np.uint16)

        bits |= np.uint16(1 << pyramid.hour_bit(13))

        self.assertTrue(pyramid.hour_mask(bits, 13).all())
        for hour in EXPECTED_HOUR_BITS:
            if hour != 13:
                self.assertFalse(pyramid.hour_mask(bits, hour).any(),
                                 f"{hour}:00 leaked from the 13:00 bit")

    def test_the_shaded_hour_count_is_the_population_count_of_the_mask(self):
        raw, _ = sample_masks()

        counts = pyramid.shaded_hours(raw)

        expected = sum(((raw >> position) & 1).astype(np.uint8)
                       for position in range(15))
        np.testing.assert_array_equal(counts, expected)
        self.assertEqual(counts.dtype, np.dtype("uint8"))
        self.assertLessEqual(int(counts.max()), 15)

    def test_a_fully_shaded_pixel_counts_fifteen_not_more(self):
        bits = np.full((2, 2), pyramid.ALL_HOURS, dtype=np.uint16)

        self.assertTrue((pyramid.shaded_hours(bits) == 15).all())


class BitRangeTests(unittest.TestCase):
    """No bit above position 14, ever, on either surface."""

    def test_a_clean_mask_passes(self):
        raw, corrected = sample_masks()

        pyramid.check_bits(raw)
        pyramid.check_bits(corrected)

    def test_a_bit_above_fourteen_is_refused(self):
        bits = np.zeros((3, 3), dtype=np.uint16)
        bits[1, 1] = 1 << 15

        with self.assertRaises(ValueError):
            pyramid.check_bits(bits)

    def test_the_encoder_refuses_a_mask_it_cannot_carry(self):
        raw, _ = sample_masks()
        raw = raw.copy()
        raw[0, 0] = 1 << 15

        with self.assertRaises(ValueError):
            pyramid.encode_tile(raw)

    @unittest.skipUnless(
        os.path.exists(os.path.join(PROCESSED, "shade-raw.tif")),
        "the citywide rasters are gitignored; run 31_build_shade.py")
    def test_the_citywide_rasters_still_satisfy_the_invariant(self):
        import rasterio

        for name in ("shade-raw.tif", "shade-corrected.tif"):
            with self.subTest(raster=name):
                with rasterio.open(os.path.join(PROCESSED, name)) as src:
                    highest = 0
                    for _, window in src.block_windows(1):
                        highest = max(highest,
                                      int(src.read(1, window=window).max()))
                self.assertLessEqual(highest, pyramid.ALL_HOURS)


class DawnTests(unittest.TestCase):
    """06:00 is shaded everywhere by construction, and must stay that way."""

    def test_the_dawn_bit_is_position_zero(self):
        self.assertEqual(pyramid.DAWN_HOUR, 6)
        self.assertEqual(pyramid.hour_bit(pyramid.DAWN_HOUR), 0)

    def test_ground_with_the_dawn_bit_everywhere_passes(self):
        raw, _ = sample_masks()
        ground = np.ones(raw.shape, dtype=bool)

        self.assertTrue(pyramid.dawn_is_universal(raw, ground))

    def test_one_ground_pixel_without_the_dawn_bit_fails(self):
        raw, _ = sample_masks()
        raw = raw.copy()
        raw[2, 3] &= np.uint16(pyramid.ALL_HOURS ^ 1)
        ground = np.ones(raw.shape, dtype=bool)

        self.assertFalse(pyramid.dawn_is_universal(raw, ground))

    def test_a_non_ground_pixel_without_the_dawn_bit_is_not_a_failure(self):
        raw, _ = sample_masks()
        raw = raw.copy()
        raw[2, 3] &= np.uint16(pyramid.ALL_HOURS ^ 1)
        ground = np.ones(raw.shape, dtype=bool)
        ground[2, 3] = False

        self.assertTrue(pyramid.dawn_is_universal(raw, ground))


class TileEncodingTests(unittest.TestCase):
    """One square tile per surface, and nothing hiding in an alpha channel."""

    def test_a_tile_is_a_single_array_not_one_band_per_hour(self):
        raw, _ = sample_masks(8, 8)

        pixels = pyramid.encode_tile(raw)

        self.assertIsInstance(pixels, np.ndarray)
        self.assertEqual(pixels.dtype, np.dtype("uint8"))
        self.assertEqual(pixels.shape, (8, 8, pyramid.CHANNELS))

    def test_a_tile_is_square_so_a_raster_dem_source_can_read_it(self):
        raw, _ = sample_masks(pyramid.TILE_SIZE, pyramid.TILE_SIZE)

        pixels = pyramid.encode_tile(raw)

        self.assertEqual(pixels.shape[0], pixels.shape[1])

    def test_the_channel_count_does_not_track_the_number_of_hours(self):
        raw, _ = sample_masks()

        pixels = pyramid.encode_tile(raw)

        self.assertLess(pixels.shape[2], len(pyramid.HOUR_BITS),
                        "fifteen channels would be one band per hour, which "
                        "is the encoding this contract exists to forbid")

    def test_the_red_channel_is_the_shaded_hour_count(self):
        raw, _ = sample_masks(8, 8)

        pixels = pyramid.encode_tile(raw)

        np.testing.assert_array_equal(pixels[:, :, 0],
                                      pyramid.shaded_hours(raw))

    def test_the_mask_survives_the_round_trip(self):
        raw, corrected = sample_masks()

        for surface in (raw, corrected):
            with self.subTest():
                np.testing.assert_array_equal(
                    pyramid.decode_tile(pyramid.encode_tile(surface)), surface)

    def test_every_hour_survives_the_round_trip(self):
        raw, _ = sample_masks()

        decoded = pyramid.decode_tile(pyramid.encode_tile(raw))

        for hour in pyramid.HOUR_BITS:
            with self.subTest(hour=hour):
                np.testing.assert_array_equal(pyramid.hour_mask(decoded, hour),
                                              pyramid.hour_mask(raw, hour))

    def test_a_tampered_count_channel_is_caught(self):
        raw, _ = sample_masks(8, 8)
        pixels = pyramid.encode_tile(raw)
        pixels[0, 0, 0] = (int(pixels[0, 0, 0]) + 1) % 16

        with self.assertRaises(ValueError):
            pyramid.decode_tile(pixels, verify=True)

    def test_no_payload_is_parked_in_the_alpha_channel(self):
        """Canvas unpremultiplies on read, so alpha cannot carry data."""
        raw, _ = sample_masks()

        pixels = pyramid.encode_tile(raw)

        if pixels.shape[2] < 4:
            self.skipTest("the encoding has no alpha channel to misuse")
        self.assertEqual(set(np.unique(pixels[:, :, 3]).tolist()), {255})

    def test_an_all_zero_tile_round_trips_as_all_zero(self):
        empty = np.zeros((4, 4), dtype=np.uint16)

        self.assertFalse(pyramid.decode_tile(pyramid.encode_tile(empty)).any())

    def test_a_fully_shaded_tile_round_trips_at_the_top_of_the_range(self):
        full = np.full((4, 4), pyramid.ALL_HOURS, dtype=np.uint16)

        decoded = pyramid.decode_tile(pyramid.encode_tile(full))

        self.assertTrue((decoded == pyramid.ALL_HOURS).all())


class SeparateAddressingTests(unittest.TestCase):
    """Both surfaces present, and reachable independently."""

    def test_each_surface_has_its_own_url_template(self):
        templates = pyramid.tile_url_templates()

        self.assertEqual(set(templates), set(pyramid.SURFACES))
        self.assertNotEqual(templates["raw"], templates["corrected"])
        for surface, template in templates.items():
            for placeholder in ("{z}", "{x}", "{y}"):
                self.assertIn(placeholder, template)
            self.assertIn(surface, template)
            self.assertTrue(template.endswith(f".{pyramid.TILE_FORMAT}"))

    def test_an_unknown_surface_has_no_url(self):
        with self.assertRaises(ValueError):
            pyramid.tile_url_template("cooler")

    def test_the_unpack_constants_are_maplibres_default_encoding(self):
        """Not configuration. These are the numbers MapLibre compiles in."""
        unpack = pyramid.DEM_UNPACK

        self.assertEqual(unpack["encoding"], "mapbox")
        self.assertEqual(unpack["redFactor"], 6553.6)
        self.assertEqual(unpack["greenFactor"], 25.6)
        self.assertEqual(unpack["blueFactor"], 0.1)
        self.assertEqual(unpack["baseShift"], 10000.0)

    def test_the_mask_can_never_push_a_pixel_into_another_counts_band(self):
        """The whole reason the count sits in red and rides the default.

        Green and blue at their maximum add 6553.5, and one step of red is
        6553.6. If that ever stopped being true the map would colour some
        pixels by the wrong count and nothing else would notice.
        """
        widest = pyramid.dem_unpack(0, 255, 255) - pyramid.dem_unpack(0, 0, 0)

        self.assertLess(widest, pyramid.DEM_UNPACK["redFactor"])

        for count in range(pyramid.MAX_BIT + 1):
            with self.subTest(count=count):
                floor = pyramid.dem_unpack(count, 0, 0)
                ceiling = pyramid.dem_unpack(count, 255, 255)
                self.assertEqual(floor, pyramid.dem_value(count))
                self.assertLess(ceiling, pyramid.dem_value(count + 1))

    def test_every_pixel_lands_in_the_band_for_its_own_count(self):
        raw, _ = sample_masks(16, 16)
        pixels = pyramid.encode_tile(raw)
        counts = pyramid.shaded_hours(raw)

        for row in range(16):
            for col in range(16):
                red, green, blue = (int(v) for v in pixels[row, col])
                value = pyramid.dem_unpack(red, green, blue)
                count = int(counts[row, col])
                self.assertGreaterEqual(value, pyramid.dem_value(count))
                self.assertLess(value, pyramid.dem_value(count + 1))


class SurfaceNamingTests(unittest.TestCase):
    """The two surfaces are named the same way everywhere in the pipeline."""

    def test_both_surfaces_are_declared_and_ordered_measured_first(self):
        self.assertEqual(pyramid.SURFACES, ("raw", "corrected"))

    def test_no_surface_name_makes_a_thermal_claim(self):
        forbidden = ("cool", "heat", "hot", "warm", "temperature", "thermal")

        for surface in pyramid.SURFACES:
            for word in forbidden:
                self.assertNotIn(word, surface.lower(),
                                 "this guide maps shade, never temperature")


if __name__ == "__main__":
    unittest.main()
