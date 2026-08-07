"""The one winter figure chapter six promised.

The guide is a July guide. Every other number in it comes from 21 July 2026
across fifteen hourly frames. Chapter six argues that the map turns over in
winter and marked its figure pending rather than estimating it, and this
pays that off with a single measurement: the share of Toronto's ground in
shade at the modelled hour nearest January solar noon.

**One frame, not a winter day.** A winter sun sits at 1.73 degrees at 17:00,
where a 600 m object throws 19.9 km, so padding every window against the
whole January day is a 24,000 px square read and a modelled 171 hours
against July's 3.69. The noon frame needs 1,217 m and eight minutes. What
this figure does not support is any claim about how long winter shade lasts,
only how much of the ground it covers at midday.

**The corrected column is a summer counterfactual.** The leaf-on correction
raises bare canopy to the height it would reach in leaf. In January the
trees really are bare, so the measured surface is the physically right one
and the corrected column is here because this guide prints both numbers
everywhere, not because January has leaves.

**This measures shade, not temperature.** A winter shadow is not a claim
about cold any more than a summer one is a claim about heat.

Usage: python 35_fg04_january.py [--blocks 2048]
"""

import argparse
import json
import os

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.windows import Window

import fg04_canopy as canopy
import fg04_solar as solar
from fg04_stats import all_hours, frame_share

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
RAW = os.path.join(DATA, "raw", "fg04")
PROCESSED = os.path.join(DATA, "processed", "fg04")
PROOF = os.path.join(DATA, "proof", "fg04")
LAND_COVER = os.path.join(RAW, "landcover", "LandCover2018.gdb")

SURFACES = ("raw", "corrected")


def tagged(stem, tag):
    return os.path.join(PROCESSED, f"{stem}{tag}.tif")


def july_minimum():
    """July's published minimum-frame share, for the comparison."""
    path = os.path.join(PROOF, "statistics.json")
    if not os.path.exists(path):
        return None
    with open(path) as handle:
        stats = json.load(handle)
    return {
        surface: stats["surfaces"][surface]["minimum_frame"]
        for surface in SURFACES
        if surface in stats.get("surfaces", {})
    }


def measure(tag, hours, block):
    raw_path = tagged("shade-raw", tag)
    if not os.path.exists(raw_path):
        raise SystemExit(
            f"{raw_path} is missing; run\n"
            f"  python 31_build_shade.py --resolution 2 "
            f"--date {solar.WINTER_DATE} --hours 12")

    with rasterio.open(raw_path) as probe:
        crs, transform = probe.crs, probe.transform
        width, height = probe.width, probe.height
    print(f"grid {width} x {height} in {crs}, {len(hours)} frame(s): {hours}")

    cover = gpd.read_file(LAND_COVER, layer="LandCover2018",
                          columns=["gridcode"])
    everything = all_hours(len(hours))

    sources = {s: rasterio.open(tagged(f"shade-{s}", tag)) for s in SURFACES}
    ground_src = rasterio.open(tagged("ground", tag))
    totals = {s: [0, 0] for s in SURFACES}
    try:
        blocks = [(row, col)
                  for row in range(0, height, block)
                  for col in range(0, width, block)]
        for index, (row, col) in enumerate(blocks, start=1):
            window = Window(col, row,
                            min(block, width - col), min(block, height - row))
            ground = ground_src.read(1, window=window) == 1
            if not ground.any():
                continue
            shape = (int(window.height), int(window.width))
            win_transform = rasterio.windows.transform(window, transform)

            # The same under-canopy rule every corrected statistic gets.
            # Without it, ground beneath a crown reads as sunlit, because
            # raising the surface lifts the sample point to the treetop and
            # a treetop is in full sun.
            tree = canopy.class_mask(cover, {canopy.TREE_CODE}, shape,
                                     win_transform, crs)
            under_canopy = ground & tree

            for surface in SURFACES:
                bits = sources[surface].read(1, window=window)
                if surface == "corrected":
                    bits = np.where(under_canopy, everything,
                                    bits).astype(np.uint16)
                total, shaded = frame_share(bits, ground, bit=0)
                totals[surface][0] += total
                totals[surface][1] += shaded

            if index % 25 == 0 or index == len(blocks):
                print(f"  block {index}/{len(blocks)}", flush=True)
    finally:
        ground_src.close()
        for handle in sources.values():
            handle.close()
    return totals


def main(block):
    frame = solar.frame_nearest_solar_noon(solar.WINTER_DATE)
    hours = [int(frame.clock.hour)]
    tag = f"-{solar.WINTER_DATE}-h" + "-".join(f"{h:02d}" for h in hours)
    noon = solar.solar_noon(solar.WINTER_DATE)
    print(f"{solar.WINTER_DATE}: solar noon {noon.strftime('%H:%M')}, "
          f"nearest modelled hour {frame.clock.strftime('%H:%M')} at "
          f"{frame.altitude:.2f} deg")

    totals = measure(tag, hours, block)
    july = july_minimum()

    report = {
        "date": solar.WINTER_DATE,
        "hour": hours[0],
        "solar_noon": noon.strftime("%H:%M %z"),
        "altitude_deg": round(frame.altitude, 2),
        "azimuth_deg": round(frame.azimuth, 2),
        "resolution_m": 2.0,
        "frames": 1,
        "note": ("one frame at the modelled hour nearest January solar noon; "
                 "it says how much ground is shaded at midday and nothing "
                 "about how long winter shade lasts"),
        "corrected_note": ("the leaf-on correction models summer foliage; in "
                           "January the trees are bare, so the measured "
                           "column is the physically right one"),
        "surfaces": {},
    }
    for surface in SURFACES:
        total, shaded = totals[surface]
        report["surfaces"][surface] = {
            "ground_pixels": total,
            "shaded_ground_pixels": shaded,
            "shaded_fraction": round(shaded / total, 4) if total else None,
        }
    if july:
        report["july_minimum_frame"] = july

    os.makedirs(PROOF, exist_ok=True)
    out = os.path.join(PROOF, "january.json")
    with open(out, "w") as handle:
        json.dump(report, handle, indent=2)

    print()
    for surface in SURFACES:
        share = report["surfaces"][surface]["shaded_fraction"]
        line = f"[{surface}] ground shaded at {hours[0]}:00 in January: "
        line += "unsampled" if share is None else f"{share * 100:.2f}%"
        if july and surface in july:
            line += (f"   (July {july[surface]['hour']}:00 minimum: "
                     f"{july[surface]['shaded_fraction'] * 100:.2f}%)")
        print(line)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--blocks", type=int, default=2048)
    args = parser.parse_args()
    main(args.blocks)
