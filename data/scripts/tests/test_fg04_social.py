import importlib.util
import io
import os
import unittest
from contextlib import redirect_stderr

from PIL import Image


SCRIPT = os.path.join(os.path.dirname(__file__), "..", "36_fg04_social.py")
SPEC = importlib.util.spec_from_file_location("fg04_social_script", SCRIPT)
SOCIAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOCIAL)


class SocialFrameTests(unittest.TestCase):
    def test_cli_refuses_a_surface_that_would_mislabel_the_image(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            SOCIAL.parse_args(["--surface", "corrected"])

    def test_published_surface_is_always_the_measurement(self):
        self.assertEqual(SOCIAL.SURFACE, "raw")

    def test_divider_splits_the_panels_and_sets_nothing_over_the_map(self):
        frame = Image.new("RGB", (1200, 630), SOCIAL.BUILT)

        result = SOCIAL.add_divider(frame)

        self.assertEqual(result.size, (1200, 630))
        self.assertEqual(result.getpixel((600, 250)), SOCIAL.SHADED)
        self.assertEqual(result.getpixel((600, 625)), SOCIAL.SHADED)
        # The card is the picture alone: where the hour labels and the title
        # bar used to sit, the frame is untouched.
        self.assertEqual(result.getpixel((48, 48)), SOCIAL.BUILT)
        self.assertEqual(result.getpixel((48, 576)), SOCIAL.BUILT)
        self.assertEqual(result.getpixel((680, 590)), SOCIAL.BUILT)


if __name__ == "__main__":
    unittest.main()
