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

That invariant decides the layout, because the two cannot both hold in one
pixel: fifteen bits on two surfaces is thirty bits and RGB carries
twenty-four. So a tile is one image of **stacked halves**, the measured
surface above the corrected one, three channels each:

    R  mask bits 0 to 7
    G  mask bits 8 to 14, top bit unused
    B  shaded-hours count, 0 to 15

B is derived from R and G and is redundant on purpose. The count layer is
what the reader sees first, and making it a channel read rather than a
population count in a shader is worth one third of a tile. It is pinned
here as equal to the population count so the two can never drift.
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
        raw, corrected = sample_masks()
        raw = raw.copy()
        raw[0, 0] = 1 << 15

        with self.assertRaises(ValueError):
            pyramid.encode_tile(raw, corrected)

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
    """One raster, two surfaces, and nothing hiding in the alpha channel."""

    def test_a_tile_is_a_single_array_not_one_band_per_hour(self):
        height, width = 8, 8
        raw, corrected = sample_masks(height, width)

        pixels = pyramid.encode_tile(raw, corrected)

        self.assertIsInstance(pixels, np.ndarray)
        self.assertEqual(pixels.dtype, np.dtype("uint8"))
        self.assertEqual(pixels.shape, (height * 2, width, pyramid.CHANNELS))

    def test_the_channel_count_does_not_track_the_number_of_hours(self):
        raw, corrected = sample_masks()

        pixels = pyramid.encode_tile(raw, corrected)

        self.assertLess(pixels.shape[2], len(pyramid.HOUR_BITS),
                        "fifteen channels would be one band per hour, which "
                        "is the encoding this contract exists to forbid")

    def test_the_measured_surface_is_the_top_half(self):
        raw, corrected = sample_masks(8, 8)

        pixels = pyramid.encode_tile(raw, corrected)

        top = pyramid.decode_half(pixels[:8])
        bottom = pyramid.decode_half(pixels[8:])
        np.testing.assert_array_equal(top, raw)
        np.testing.assert_array_equal(bottom, corrected)

    def test_the_blue_channel_is_the_shaded_hour_count(self):
        raw, corrected = sample_masks(8, 8)

        pixels = pyramid.encode_tile(raw, corrected)

        np.testing.assert_array_equal(pixels[:8, :, 2],
                                      pyramid.shaded_hours(raw))
        np.testing.assert_array_equal(pixels[8:, :, 2],
                                      pyramid.shaded_hours(corrected))

    def test_the_count_channel_can_never_disagree_with_the_mask(self):
        raw, corrected = sample_masks(8, 8)
        pixels = pyramid.encode_tile(raw, corrected)

        decoded = pyramid.decode_tile(pixels)

        for half, surface in ((slice(0, 8), "raw"), (slice(8, 16), "corrected")):
            np.testing.assert_array_equal(
                pixels[half, :, 2], pyramid.shaded_hours(decoded[surface]))

    def test_a_tampered_count_channel_is_caught(self):
        raw, corrected = sample_masks(8, 8)
        pixels = pyramid.encode_tile(raw, corrected)
        pixels[0, 0, 2] = (int(pixels[0, 0, 2]) + 1) % 16

        with self.assertRaises(ValueError):
            pyramid.decode_tile(pixels, verify=True)

    def test_both_surfaces_survive_the_round_trip(self):
        raw, corrected = sample_masks()

        decoded = pyramid.decode_tile(pyramid.encode_tile(raw, corrected))

        self.assertEqual(set(decoded), set(pyramid.SURFACES))
        np.testing.assert_array_equal(decoded["raw"], raw)
        np.testing.assert_array_equal(decoded["corrected"], corrected)

    def test_the_two_surfaces_are_separately_addressable(self):
        raw, corrected = sample_masks()
        changed = raw.copy()
        changed[0, 0] ^= np.uint16(1 << pyramid.hour_bit(12))

        first = pyramid.decode_tile(pyramid.encode_tile(raw, corrected))
        second = pyramid.decode_tile(pyramid.encode_tile(changed, corrected))

        self.assertNotEqual(int(first["raw"][0, 0]), int(second["raw"][0, 0]))
        np.testing.assert_array_equal(first["corrected"], second["corrected"])

    def test_every_hour_survives_the_round_trip_on_both_surfaces(self):
        raw, corrected = sample_masks()

        decoded = pyramid.decode_tile(pyramid.encode_tile(raw, corrected))

        for hour in pyramid.HOUR_BITS:
            with self.subTest(hour=hour):
                np.testing.assert_array_equal(
                    pyramid.hour_mask(decoded["raw"], hour),
                    pyramid.hour_mask(raw, hour))
                np.testing.assert_array_equal(
                    pyramid.hour_mask(decoded["corrected"], hour),
                    pyramid.hour_mask(corrected, hour))

    def test_no_payload_is_parked_in_the_alpha_channel(self):
        """Canvas unpremultiplies on read, so alpha cannot carry data."""
        raw, corrected = sample_masks()

        pixels = pyramid.encode_tile(raw, corrected)

        if pixels.shape[2] < 4:
            self.skipTest("the encoding has no alpha channel to misuse")
        self.assertEqual(set(np.unique(pixels[:, :, 3]).tolist()), {255},
                         "alpha must be a constant 255. Canvas stores pixels "
                         "premultiplied and rounds them back on read, so a "
                         "byte in alpha decodes wrong and decodes to nothing "
                         "wherever alpha is zero.")

    def test_an_all_zero_tile_round_trips_as_all_zero(self):
        empty = np.zeros((4, 4), dtype=np.uint16)

        decoded = pyramid.decode_tile(pyramid.encode_tile(empty, empty))

        self.assertFalse(decoded["raw"].any())
        self.assertFalse(decoded["corrected"].any())

    def test_a_fully_shaded_tile_round_trips_at_the_top_of_the_range(self):
        full = np.full((4, 4), pyramid.ALL_HOURS, dtype=np.uint16)

        decoded = pyramid.decode_tile(pyramid.encode_tile(full, full))

        self.assertTrue((decoded["raw"] == pyramid.ALL_HOURS).all())
        self.assertTrue((decoded["corrected"] == pyramid.ALL_HOURS).all())


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
