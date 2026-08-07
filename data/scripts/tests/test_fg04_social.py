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

    def test_editorial_overlay_preserves_size_and_marks_comparison(self):
        frame = Image.new("RGB", (1200, 630), SOCIAL.BUILT)

        result = SOCIAL.add_editorial_context(frame)

        self.assertEqual(result.size, (1200, 630))
        self.assertEqual(result.getpixel((600, 250)), SOCIAL.SHADED)
        self.assertNotEqual(result.getpixel((48, 48)), SOCIAL.BUILT)
        self.assertNotEqual(result.getpixel((48, 576)), SOCIAL.BUILT)


if __name__ == "__main__":
    unittest.main()
