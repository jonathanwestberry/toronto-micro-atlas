"""Publish the transit stops with no usable shade as a set the reader can walk.

The guide already prints the count. `32_fg04_stats.py` writes it to the proof
file and deliberately publishes a number rather than names, because the five
"sunniest" stops it also records are an argsort slice of a large tied set: it
can name five and can never say how many there are.

This script publishes the whole set instead, which is a different object from
a top-five slice. Every stop in it sits at the same single frame, so there is
no worst one, and nothing here ranks them. They are sorted by name and the
route page says so, because a reader handed a list will read the top of it as
the worst place in the city unless told otherwise.

The count is asserted against the proof file rather than recomputed loosely.
`data/proof/fg04/statistics.json` is the record, and a set that disagreed with
it would be a second, quieter answer to a question that already has one.

Usage: python 39_fg04_no_shade_stops.py
"""

import json
import os

import geopandas as gpd

import importlib.util

from fg04_stats import bare_on_every_surface, no_shade_stop_records

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
PROOF = os.path.join(DATA, "proof", "fg04")
OUT_DIR = os.path.join(ROOT, "public", "data", "fg04")
OUT_FILE = os.path.join(OUT_DIR, "no-shade-stops.json")


def load_stats_module():
    """Import 32_fg04_stats.py, whose name starts with a digit."""
    path = os.path.join(HERE, "32_fg04_stats.py")
    spec = importlib.util.spec_from_file_location("fg04_stats_driver", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    stats = load_stats_module()

    proof_path = os.path.join(PROOF, "statistics.json")
    with open(proof_path) as handle:
        proof = json.load(handle)
    expected = proof["transit_stops_no_usable_shade_both_surfaces"]

    raw_path = os.path.join(stats.PROCESSED, "shade-raw.tif")
    if not os.path.exists(raw_path):
        raise SystemExit("run 31_build_shade.py first")
    import rasterio
    with rasterio.open(raw_path) as probe:
        crs = probe.crs

    _, _, _, stops = stats.load_layers(crs)

    # The under-canopy rule on the corrected surface needs the tree class, and
    # sample_stops() silently skips it when trees are absent. Passing them is
    # not optional: without it every stop under a street tree reads as sunlit
    # and the bare set inflates.
    cover = gpd.read_file(
        os.path.join(stats.RAW, "landcover", "LandCover2018.gdb"),
        layer="LandCover2018", columns=["gridcode"])
    trees = cover[cover["gridcode"] == stats.fg04_canopy.TREE_CODE].to_crs(crs)
    trees = trees.reset_index(drop=True)

    hours_by_surface = {
        surface: stats.sample_stops(stops, surface, trees)
        for surface in stats.SURFACES
    }
    # Ground only, exactly as the statistic is formed. A stop whose coordinate
    # lands on a shelter roof or a station canopy was never measured at the
    # height a person stands, and a roof is lit all day, so including them
    # selected for roofs: the set was 533 before this restriction and 487 of
    # those sat on non-ground pixels.
    sampled_ground = stats.stops_on_sampled_ground(stops)
    mask = bare_on_every_surface(hours_by_surface) & sampled_ground

    if int(sampled_ground.sum()) != expected["of_total"]:
        raise SystemExit(
            f"measured {int(sampled_ground.sum())} stops on sampled ground "
            f"but the proof file records {expected['of_total']}")
    if int(mask.sum()) != expected["count"]:
        raise SystemExit(
            f"selected {int(mask.sum())} stops but the proof file records "
            f"{expected['count']}; the set and the count must agree")

    geographic = stops.to_crs("EPSG:4326")
    records = no_shade_stop_records(
        mask,
        names=list(stops["name"]),
        ids=list(stops["id"]),
        lons=[point.x for point in geographic.geometry],
        lats=[point.y for point in geographic.geometry],
    )

    payload = {
        "count": len(records),
        "ofTotal": int(expected["of_total"]),
        "sharePercent": expected["share_percent"],
        "excludedNotSampledGround": int(expected["excluded_not_sampled_ground"]),
        "publishedStops": int(expected["published_stops"]),
        "order": "name",
        "stops": records,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_FILE, "w") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    size_kb = os.path.getsize(OUT_FILE) / 1024
    print(f"{len(records)} stops with no usable shade on either surface")
    print(f"of {expected['of_total']} sampled ({expected['share_percent']}%)")
    print(f"wrote {OUT_FILE} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
