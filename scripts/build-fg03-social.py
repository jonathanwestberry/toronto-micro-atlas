#!/usr/bin/env python3
"""Build the reproducible 1200 by 630 social card for When Toronto Has to Go.

The card is the map and nothing else: no title, figures or labels set over
it. The page's title and description travel with every link preview, and the
page's og:image:alt describes the picture.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ROOT = ROOT / "public" / "data" / "fg03"
PROOF_ROOT = ROOT / "data" / "proof" / "fg03"
OUTPUT = ROOT / "public" / "social" / "og-when-toronto-has-to-go.jpg"

WIDTH = 1200
HEIGHT = 630
# The proof render keeps the colours it was recorded in, and carries its own
# title (top left, on bare ground above the city), legend (bottom left) and
# footnote (bottom). The title is painted out in the render's ground colour,
# and the crop stops above the legend: the whole width of the city at the
# card's 1.9:1, with the lakeshore's southern tips bleeding off the bottom.
# Fractions of the render, measured on coverage-2200.png.
TITLE_BAND = (0.0, 0.0, 0.82, 0.10)
CROP = (0.035, 0.08, 0.957, 0.84)


def _latest_snapshot() -> tuple[Path, dict]:
    snapshots = sorted(
        path
        for path in PUBLIC_ROOT.iterdir()
        if path.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", path.name)
    )
    if not snapshots:
        raise RuntimeError("FG03 social art requires a dated public snapshot")
    snapshot = snapshots[-1]
    return snapshot, json.loads((snapshot / "manifest.json").read_text())


def _map(snapshot_name: str) -> Image.Image:
    source_path = PROOF_ROOT / snapshot_name / "coverage-2200.png"
    with Image.open(source_path) as source:
        source = source.convert("RGB")
        ground = source.getpixel((source.width - 5, 5))
        left, top, right, bottom = TITLE_BAND
        ImageDraw.Draw(source).rectangle(
            (
                round(source.width * left),
                round(source.height * top),
                round(source.width * right),
                round(source.height * bottom),
            ),
            fill=ground,
        )
        left, top, right, bottom = CROP
        crop = source.crop(
            (
                round(source.width * left),
                round(source.height * top),
                round(source.width * right),
                round(source.height * bottom),
            )
        )
        return ImageOps.fit(crop, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)


def build() -> bytes:
    snapshot, _manifest = _latest_snapshot()
    canvas = _map(snapshot.name)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(
        OUTPUT,
        format="JPEG",
        quality=86,
        optimize=True,
        progressive=True,
        subsampling=2,
        exif=b"",
    )
    payload = OUTPUT.read_bytes()
    with Image.open(OUTPUT) as result:
        if result.size != (WIDTH, HEIGHT) or result.mode != "RGB":
            raise RuntimeError("FG03 social art failed its image contract")
    return payload


if __name__ == "__main__":
    payload = build()
    print(
        json.dumps(
            {
                "bytes": len(payload),
                "height": HEIGHT,
                "output": str(OUTPUT.relative_to(ROOT)),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "width": WIDTH,
            },
            sort_keys=True,
        )
    )
