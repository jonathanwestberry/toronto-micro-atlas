#!/usr/bin/env python3
"""Build the reproducible 1200 by 630 social card for Field Guide 03."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ROOT = ROOT / "public" / "data" / "fg03"
PROOF_ROOT = ROOT / "data" / "proof" / "fg03"
OUTPUT = ROOT / "public" / "social" / "og-when-toronto-has-to-go.jpg"

WIDTH = 1200
HEIGHT = 630
PAPER = "#F3EDDD"
INK = "#1A1F2A"
MUTED = "#625E58"
MAUVE = "#8A4A70"
RULE = "#CFC5B0"

ARCHIVO = (
    ROOT
    / "node_modules"
    / "@fontsource-variable"
    / "archivo"
    / "files"
    / "archivo-latin-wght-normal.woff2"
)
SOURCE_SERIF = (
    ROOT
    / "node_modules"
    / "@fontsource-variable"
    / "source-serif-4"
    / "files"
    / "source-serif-4-latin-wght-normal.woff2"
)


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


def _font(path: Path, size: int, weight: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(path, size)
    font.set_variation_by_axes([weight])
    return font


def _fit_size(
    draw: ImageDraw.ImageDraw,
    text: str,
    path: Path,
    weight: int,
    maximum: int,
    minimum: int,
    width: int,
) -> ImageFont.FreeTypeFont:
    for size in range(maximum, minimum - 1, -1):
        font = _font(path, size, weight)
        left, _top, right, _bottom = draw.textbbox((0, 0), text, font=font)
        if right - left <= width:
            return font
    raise RuntimeError(f"Could not fit social-card text: {text}")


def _map_panel(snapshot_name: str) -> Image.Image:
    source_path = PROOF_ROOT / snapshot_name / "coverage-2200.png"
    with Image.open(source_path) as source:
        source = source.convert("RGB")
        crop = source.crop(
            (
                round(source.width * 0.27),
                round(source.height * 0.13),
                round(source.width * 0.94),
                round(source.height * 0.90),
            )
        )
        panel = ImageOps.fit(
            crop,
            (660, HEIGHT),
            method=Image.Resampling.LANCZOS,
            centering=(0.56, 0.50),
        )
    panel = ImageEnhance.Color(panel).enhance(0.72)
    panel = ImageEnhance.Contrast(panel).enhance(1.08)
    tint = Image.new("RGB", panel.size, PAPER)
    return Image.blend(panel, tint, 0.10)


def build() -> bytes:
    snapshot, manifest = _latest_snapshot()
    finding = manifest["headlines"]["bySnapshot"]["2200"]["phase1Grouped"]
    unrestricted = int(finding["unrestrictedOpenAccessPointCount"])
    active = int(finding["activeTransitPointCount"])
    if finding["unit"] != "grouped transit points":
        raise RuntimeError("FG03 social art received an unexpected Phase 1 unit")

    canvas = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    canvas.paste(_map_panel(snapshot.name), (540, 0))
    draw = ImageDraw.Draw(canvas)

    draw.rectangle((0, 0, 540, HEIGHT), fill=PAPER)
    draw.line((539, 0, 539, HEIGHT), fill=INK, width=2)
    draw.rectangle((60, 48, 64, 582), fill=MAUVE)

    label_font = _font(ARCHIVO, 18, 760)
    draw.text(
        (92, 52),
        "TORONTO MICRO-ATLAS  /  FIELD GUIDE 03",
        fill=MAUVE,
        font=label_font,
        spacing=0,
    )

    title_lines = (
        ("WHEN", 72),
        ("TORONTO", 72),
        ("HAS TO GO", 68),
    )
    for index, (line, maximum) in enumerate(title_lines):
        title_font = _fit_size(
            draw,
            line,
            ARCHIVO,
            850,
            maximum,
            48,
            400,
        )
        draw.text((92, 104 + index * 60), line, fill=INK, font=title_font)
    draw.line((92, 296, 500, 296), fill=RULE, width=2)

    time_font = _font(ARCHIVO, 20, 760)
    number_font = _font(ARCHIVO, 44, 820)
    draw.text((92, 318), "AT 10 P.M.", fill=MAUVE, font=time_font)
    draw.text((92, 352), f"{unrestricted:,}", fill=INK, font=number_font)
    draw.text(
        (162, 360),
        "unrestricted access",
        fill=INK,
        font=_fit_size(
            draw,
            "unrestricted access",
            SOURCE_SERIF,
            520,
            28,
            24,
            330,
        ),
    )
    draw.text(
        (92, 400),
        "points documented open.",
        fill=INK,
        font=_fit_size(
            draw,
            "points documented open.",
            SOURCE_SERIF,
            520,
            28,
            24,
            408,
        ),
    )
    draw.text((92, 442), f"{active:,}", fill=INK, font=number_font)
    draw.text(
        (225, 450),
        "grouped transit",
        fill=INK,
        font=_fit_size(
            draw,
            "grouped transit",
            SOURCE_SERIF,
            520,
            28,
            24,
            275,
        ),
    )
    draw.text(
        (92, 490),
        "points still have scheduled activity.",
        fill=INK,
        font=_fit_size(
            draw,
            "points still have scheduled activity.",
            SOURCE_SERIF,
            520,
            28,
            22,
            408,
        ),
    )

    footer_font = _font(ARCHIVO, 15, 650)
    draw.text(
        (92, 558),
        f"TUESDAY, {snapshot.name}  /  400 M WALK NETWORK",
        fill=MUTED,
        font=footer_font,
    )

    map_label_font = _font(ARCHIVO, 16, 740)
    map_label = "VERIFIED 10 P.M. SNAPSHOT"
    label_box = draw.textbbox((0, 0), map_label, font=map_label_font)
    label_width = label_box[2] - label_box[0]
    draw.rectangle((1140 - label_width - 24, 530, 1140, 575), fill=INK)
    draw.text(
        (1128 - label_width, 542),
        map_label,
        fill=PAPER,
        font=map_label_font,
    )

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
