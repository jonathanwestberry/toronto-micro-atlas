import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image


SCRIPTS = Path(__file__).parents[1]


def load_script(filename, module_name):
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROCESS = load_script("11_process_trees.py", "fg02_process_trees")
RENDER = load_script("13_render_trees.py", "fg02_render_trees")


def tree(botanical, index):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-79.4 + index / 1000, 43.7]},
        "properties": {
            "BOTANICAL_NAME": botanical,
            "COMMON_NAME": botanical,
            "STREETNAME": "TEST ST",
            "ADDRESS": index + 1,
            "WARD": "01",
            "DBH_TRUNK": 10,
        },
    }


class MapleGroupingTests(unittest.TestCase):
    def test_metadata_groups_named_cultivars_with_the_parent_species(self):
        botanicals = [
            "Acer platanoides",
            "Acer platanoides 'Crimson King'",
            "Acer platanoides 'Royal Red'",
            "Acer saccharum",
            "Acer saccharum 'Green Mountain'",
        ]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / "trees.geojson"
            processed = root / "processed"
            public = root / "public"
            raw.write_text(json.dumps({
                "type": "FeatureCollection",
                "features": [tree(name, i) for i, name in enumerate(botanicals)],
            }))

            with patch.object(PROCESS, "RAW", str(raw)), \
                    patch.object(PROCESS, "PROCESSED", str(processed)), \
                    patch.object(PROCESS, "PUBLIC_FG02", str(public)):
                PROCESS.main()

            meta = json.loads((public / "meta.json").read_text())
            self.assertEqual(meta["stats"]["norwayMaple"], 3)
            self.assertEqual(meta["stats"]["sugarMaple"], 2)

    def test_story_renders_highlight_every_cultivar_in_each_parent_species(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            meta_path = root / "meta.json"
            points_path = root / "trees.ndjson"
            out = root / "renders"
            out.mkdir()

            species = [
                ["Acer platanoides", "Norway maple", 0],
                ["Acer platanoides 'Crimson King'", "Norway maple Crimson King", 0],
                ["Acer platanoides 'Royal Red'", "Norway maple Royal Red", 0],
                ["Acer saccharum", "Sugar maple", 0],
                ["Acer saccharum 'Green Mountain'", "Sugar maple Green Mountain", 0],
            ]
            meta_path.write_text(json.dumps({
                "categories": [{"key": "maple", "label": "Maple", "color": "#EB6F5C"}],
                "species": species,
            }))
            points_path.write_text("".join(
                json.dumps({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-79.4 + i / 1000, 43.7]},
                    "properties": {"g": 0, "s": i},
                }) + "\n"
                for i in range(len(species))
            ))

            highlighted = {}

            def capture_render(lngs, _lats, _colors, weights, _width, out_path, **_kwargs):
                name = Path(out_path).name
                if name.startswith("maples-"):
                    highlighted[name] = int(np.isclose(weights, 1.35).sum())
                return Image.new("RGBA", (8, 8))

            with patch.object(RENDER, "META", str(meta_path)), \
                    patch.object(RENDER, "NDJSON", str(points_path)), \
                    patch.object(RENDER, "OUT", str(out)), \
                    patch.object(RENDER, "BASE_W", 8), \
                    patch.object(RENDER, "CAT_W", 8), \
                    patch.object(RENDER, "render", side_effect=capture_render):
                RENDER.main()

            self.assertEqual(highlighted["maples-norway.webp"], 3)
            self.assertEqual(highlighted["maples-sugar.webp"], 2)


if __name__ == "__main__":
    unittest.main()
