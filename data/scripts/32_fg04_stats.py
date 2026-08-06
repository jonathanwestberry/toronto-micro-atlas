"""Report the shade findings against the pre-registration.

Every statistic is produced twice, once on the measured leaf-off surface and
once on the leaf-on corrected one, and no number is written without the label
saying which it came from. The lidar was flown in April and May, so tree
shade is understated and building shade is not. A single-number comparison
between a treed neighbourhood and a towered one would manufacture an
inequality finding out of the flight calendar.

This guide maps shade. It does not map temperature, and nothing produced here
may be described as coolness.

Usage: python 32_fg04_stats.py [--blocks 2048]
"""

import argparse
import json
import os

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window

import fg04_canopy
import fg04_solar as solar
from fg04_stats import (FRAMES, HOURS, histogram, mean_from_histogram,
                        median_from_histogram, shaded_hours, shortage_share)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(DATA, ".."))
RAW = os.path.join(DATA, "raw", "fg04")
PROCESSED = os.path.join(DATA, "processed", "fg04")
PROOF = os.path.join(DATA, "proof", "fg04")

# Two sampling bands, both reported. "walk" is where people are: an arterial
# right of way runs 20 to 30 m, so the sidewalk sits 8 to 15 m out from the
# centreline. "road" is the pre-registered 6 m buffer, which on an arterial
# lands in the traffic lanes. Only 0.23 per cent of the 6 m band falls under
# tree canopy against 6.64 per cent of ground generally, because street trees
# overhang the boulevard and not the middle of the road.
BANDS = {"walk": (8.0, 15.0), "road": (0.0, 6.0)}
PRIMARY_BAND = "walk"
SHADE_POOR_N = 5            # pre-registered N
SHORTAGE_X = 25.0           # pre-registered X, per cent of arterial kilometres
SURFACES = ("raw", "corrected")
ALL_HOURS = 0x7FFF          # bits 0 to 14 set, every modelled daylight hour


def burn(geometries, values, shape, transform, dtype="int32", fill=0):
    pairs = [(g, v) for g, v in zip(geometries, values)
             if g is not None and not g.is_empty]
    if not pairs:
        return np.full(shape, fill, dtype=dtype)
    return rasterize(pairs, out_shape=shape, transform=transform,
                     fill=fill, dtype=dtype, all_touched=False)


def burn_nearby(frame, values, shape, transform, bounds, index,
                dtype="int32", fill=0):
    """Rasterise only the geometries that reach this block.

    There are 25,803 street segments and 88 blocks. Handing every segment to
    every block would rasterise two and a quarter million geometries to fill
    a raster where almost all of them fall outside the block entirely.
    """
    hits = list(index.intersection(bounds))
    if not hits:
        return np.full(shape, fill, dtype=dtype)
    return burn(frame.iloc[hits].to_numpy(), np.asarray(values)[hits],
                shape, transform, dtype=dtype, fill=fill)


def clip_to_city(frame, boundary):
    """Keep only the parts of a layer inside Toronto.

    streets-major.geojson spans the whole GTA: 2,935.3 arterial km of which
    only 1,128.6 lie in the city. Measuring a Toronto shade shortage against
    a denominator containing Mississauga and Markham is not a Toronto claim.
    """
    return frame.clip(boundary).reset_index(drop=True)


def load_layers(crs, clip_city=True):
    hoods = gpd.read_file(
        os.path.join(RAW, "neighbourhoods-4326.geojson")).to_crs(crs)
    hoods = hoods.reset_index(drop=True)
    hoods["zone"] = np.arange(1, len(hoods) + 1)

    nia = gpd.read_file(os.path.join(RAW, "nia-4326.geojson")).to_crs(crs)

    boundary = gpd.read_file(os.path.join(
        ROOT, "public", "data", "toronto-boundary.geojson")).to_crs(crs)
    city = boundary.union_all()

    major = gpd.read_file(os.path.join(
        ROOT, "public", "data", "streets-major.geojson")).to_crs(crs)
    arterial = major[major["tier"] == "major"].reset_index(drop=True)
    minor = gpd.read_file(os.path.join(
        ROOT, "public", "data", "streets-minor.geojson")).to_crs(crs)
    minor = minor.explode(index_parts=False).reset_index(drop=True)
    if clip_city:
        arterial = clip_to_city(arterial, city)
        minor = clip_to_city(minor, city)
        arterial = arterial[~arterial.geometry.is_empty]
        minor = minor[~minor.geometry.is_empty]
        arterial = arterial.reset_index(drop=True)
        minor = minor.reset_index(drop=True)

    segments = gpd.GeoDataFrame(
        {
            "name": list(arterial["name"]) + [None] * len(minor),
            "kind": ["arterial"] * len(arterial) + ["minor"] * len(minor),
            "geometry": list(arterial.geometry) + list(minor.geometry),
        },
        crs=crs,
    )
    segments["length_m"] = segments.length
    segments["zone"] = np.arange(1, len(segments) + 1)

    stops = gpd.read_file(os.path.join(
        ROOT, "public", "data", "fg03", "2026-07-21",
        "stops-1200.geojson")).to_crs(crs)
    return hoods, nia, segments, stops


def accumulate(block, crs, transform, width, height, hoods, nia, segments,
               cover):
    bands = {}
    for name, (inner, outer) in BANDS.items():
        shape_ = segments.buffer(outer)
        if inner > 0:
            shape_ = shape_.difference(segments.buffer(inner))
        bands[name] = (shape_, shape_.sindex)
    nia_union = nia.union_all()
    zones_hood, zones_seg = len(hoods) + 1, len(segments) + 1
    hood_index = hoods.sindex
    trees = cover[cover["gridcode"] == fg04_canopy.TREE_CODE].to_crs(crs)
    trees = trees.reset_index(drop=True)
    tree_index = trees.sindex

    accum = {
        surface: {
            "ground": 0,
            "frame_shaded": np.zeros(FRAMES, dtype=np.int64),
            "hood": np.zeros((zones_hood, HOURS), dtype=np.int64),
            "nia": np.zeros((2, HOURS), dtype=np.int64),
            "segment": {name: np.zeros((zones_seg, HOURS), dtype=np.int64)
                        for name in BANDS},
        }
        for surface in SURFACES
    }

    sources = {s: rasterio.open(os.path.join(PROCESSED, f"shade-{s}.tif"))
               for s in SURFACES}
    ground_src = rasterio.open(os.path.join(PROCESSED, "ground.tif"))
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
            bounds = rasterio.windows.bounds(window, transform)

            hood_labels = burn_nearby(hoods.geometry, hoods["zone"], shape,
                                      win_transform, bounds, hood_index)
            nia_labels = burn([nia_union], [1], shape, win_transform,
                              dtype="uint8")
            band_labels = {
                name: burn_nearby(geom, segments["zone"], shape,
                                  win_transform, bounds, idx)
                for name, (geom, idx) in bands.items()}
            tree = burn_nearby(trees.geometry, np.ones(len(trees)), shape,
                               win_transform, bounds, tree_index,
                               dtype="uint8").astype(bool)


            # Ground under a leaf-on crown is shaded, and the raster sweep
            # cannot say so. Raising a canopy pixel lifts the sample point
            # from the sidewalk to the treetop, and a treetop is in full sun,
            # so the corrected surface reads 2.47 fewer shaded hours under
            # canopy than the leaf-off one. That is an artefact of where the
            # surface sits, not a finding about shade.
            #
            # The leaf-off surface is left alone on purpose. In April the
            # bare crown really does let light through, and that gap between
            # the two surfaces is the leaf-off bias this guide exists to
            # report rather than something to paper over.
            under_canopy = ground & tree

            for surface in SURFACES:
                bits = sources[surface].read(1, window=window)
                if surface == "corrected":
                    bits = np.where(under_canopy, ALL_HOURS,
                                    bits).astype(np.uint16)
                hours = shaded_hours(bits)
                data = accum[surface]
                data["ground"] += int(ground.sum())
                for position in range(FRAMES):
                    lit = ((bits >> position) & 1).astype(bool)
                    data["frame_shaded"][position] += int(lit[ground].sum())
                histogram(data["hood"], hood_labels, hours, ground, zones_hood)
                histogram(data["nia"], nia_labels, hours, ground, 2)
                for name, labels in band_labels.items():
                    histogram(data["segment"][name], labels, hours,
                              ground & (labels > 0), zones_seg)

            if index % 25 == 0 or index == len(blocks):
                print(f"  block {index}/{len(blocks)}", flush=True)
        return accum, sources
    finally:
        ground_src.close()


def sample_stops(stops, surface, trees=None):
    """Shaded hours at each transit stop.

    The corrected surface gets the same under-canopy rule as every other
    corrected statistic. Without it a stop standing under a street tree is
    reported as sunlit, and "sunniest transit platform" is a superlative the
    guide intends to print.
    """
    path = os.path.join(PROCESSED, f"shade-{surface}.tif")
    coords = [(point.x, point.y) for point in stops.geometry]
    with rasterio.open(path) as src:
        values = np.array([v[0] for v in src.sample(coords)], dtype=np.uint16)
    hours = shaded_hours(values.reshape(1, -1))[0]
    if surface == "corrected" and trees is not None and len(trees):
        under = gpd.sjoin(stops[["geometry"]], trees[["geometry"]],
                          predicate="within", how="left")
        under = ~under.index_right.isna().to_numpy()[:len(hours)]
        hours = np.where(under, FRAMES, hours).astype(np.uint8)
    return hours


def summarise(surface, data, frames, hoods, nia, segments, stops,
              trees=None):
    ground_total = data["ground"]
    per_frame = [
        {"hour": int(frame.clock.hour),
         "altitude_deg": round(frame.altitude, 2),
         "shaded_fraction": round(float(count) / ground_total, 4)}
        for frame, count in zip(frames, data["frame_shaded"])
    ]
    hood_mean = mean_from_histogram(data["hood"])
    zones = segments["zone"].to_numpy()
    arterial = segments["kind"].to_numpy() == "arterial"
    lengths = segments["length_m"].to_numpy()

    bands = {}
    for name in BANDS:
        counts = data["segment"][name]
        b_mean = mean_from_histogram(counts)
        b_median = median_from_histogram(counts)
        share, poor_km, arterial_km = shortage_share(
            b_median[zones], lengths, arterial, SHADE_POOR_N)
        bands[name] = {
            "inner_m": BANDS[name][0], "outer_m": BANDS[name][1],
            "arterial_km_sampled": round(arterial_km, 1),
            "shade_poor_arterial_km": round(poor_km, 1),
            "shade_poor_share_percent": round(share, 2),
            "shortage_holds": bool(share >= SHORTAGE_X),
            "_mean": b_mean,
        }
    seg_mean = bands[PRIMARY_BAND]["_mean"]
    primary = bands[PRIMARY_BAND]
    share = primary["shade_poor_share_percent"]
    poor_km = primary["shade_poor_arterial_km"]
    arterial_km = primary["arterial_km_sampled"]

    citywide = float(mean_from_histogram(
        data["hood"].sum(axis=0, keepdims=True))[0])
    nia_mean = mean_from_histogram(data["nia"])

    names = segments["name"].to_numpy()
    art_mean = np.where(arterial, seg_mean[zones], np.nan)
    have = ~np.isnan(art_mean)
    shadiest = int(np.nanargmax(art_mean)) if have.any() else None
    sunniest = int(np.nanargmin(art_mean)) if have.any() else None

    ranked = np.argsort(np.where(np.isnan(hood_mean[1:]), -np.inf,
                                 hood_mean[1:]))
    named = [i for i in ranked if not np.isnan(hood_mean[i + 1])]
    stop_hours = sample_stops(stops, surface, trees)

    return {
        "surface": surface,
        "ground_pixels": int(ground_total),
        "citywide_mean_shaded_hours": round(citywide, 3),
        "per_frame": per_frame,
        "minimum_frame": min(per_frame, key=lambda r: r["shaded_fraction"]),
        "primary_band": PRIMARY_BAND,
        "bands": {n: {k: v for k, v in b.items() if k != "_mean"}
                  for n, b in bands.items()},
        "arterial_km_sampled": arterial_km,
        "shade_poor_arterial_km": poor_km,
        "shade_poor_share_percent": share,
        "shortage_holds": bool(share >= SHORTAGE_X),
        "nia_mean_shaded_hours": round(float(nia_mean[1]), 3),
        "non_nia_mean_shaded_hours": round(float(nia_mean[0]), 3),
        "nia_polygons": int(len(nia)),
        "shadiest_neighbourhoods": [
            {"name": str(hoods.iloc[i]["AREA_NAME"]),
             "mean_shaded_hours": round(float(hood_mean[i + 1]), 2)}
            for i in named[::-1][:5]],
        "sunniest_neighbourhoods": [
            {"name": str(hoods.iloc[i]["AREA_NAME"]),
             "mean_shaded_hours": round(float(hood_mean[i + 1]), 2)}
            for i in named[:5]],
        "shadiest_arterial": (
            {"name": str(names[shadiest]),
             "mean_shaded_hours": round(float(art_mean[shadiest]), 2)}
            if shadiest is not None else None),
        "sunniest_arterial": (
            {"name": str(names[sunniest]),
             "mean_shaded_hours": round(float(art_mean[sunniest]), 2)}
            if sunniest is not None else None),
        "transit_stops": {
            "count": int(len(stops)),
            "mean_shaded_hours": round(float(stop_hours.mean()), 2),
            "sunniest": [
                {"name": str(stops.iloc[int(i)].get("name")),
                 "shaded_hours": int(stop_hours[int(i)])}
                for i in np.argsort(stop_hours)[:5]],
        },
    }


def main(block: int) -> None:
    raw_path = os.path.join(PROCESSED, "shade-raw.tif")
    if not os.path.exists(raw_path):
        raise SystemExit("run 31_build_shade.py first")
    with rasterio.open(raw_path) as probe:
        crs, transform = probe.crs, probe.transform
        width, height = probe.width, probe.height

    print(f"grid {width} x {height} in {crs}")
    hoods, nia, segments, stops = load_layers(crs)
    cover = gpd.read_file(os.path.join(RAW, "landcover", "LandCover2018.gdb"),
                          layer="LandCover2018", columns=["gridcode"])
    trees = cover[cover["gridcode"] == fg04_canopy.TREE_CODE].to_crs(crs)
    trees = trees.reset_index(drop=True)
    print(f"{len(hoods)} neighbourhoods, {len(nia)} NIA polygons, "
          f"{len(segments)} segments "
          f"({int((segments['kind'] == 'arterial').sum())} arterial), "
          f"{len(stops)} transit stops")

    accum, sources = accumulate(block, crs, transform, width, height,
                                hoods, nia, segments, cover)
    for handle in sources.values():
        handle.close()

    frames = solar.hourly_frames()
    report = {
        "pre_registration": {
            "N": SHADE_POOR_N,
            "X_percent": SHORTAGE_X,
            "bands_m": {n: {"inner": i, "outer": o}
                        for n, (i, o) in BANDS.items()},
            "primary_band": PRIMARY_BAND,
            "frames": FRAMES,
        },
        "surfaces": {
            surface: summarise(surface, accum[surface], frames,
                               hoods, nia, segments, stops)
            for surface in SURFACES
        },
    }

    os.makedirs(PROOF, exist_ok=True)
    out = os.path.join(PROOF, "statistics.json")
    with open(out, "w") as handle:
        json.dump(report, handle, indent=2)

    for surface in SURFACES:
        block_report = report["surfaces"][surface]
        print(f"\n[{surface}] citywide mean shaded hours "
              f"{block_report['citywide_mean_shaded_hours']}, "
              f"minimum at {block_report['minimum_frame']['hour']}:00 "
              f"({block_report['minimum_frame']['shaded_fraction']})")
        for name, band in block_report["bands"].items():
            mark = " <- governs the title" if name == PRIMARY_BAND else ""
            print(f"    {name:5s} band {band['inner_m']:.0f}-{band['outer_m']:.0f} m: "
                  f"shade-poor {band['shade_poor_share_percent']}% of "
                  f"{band['arterial_km_sampled']} km, "
                  f"shortage {band['shortage_holds']}{mark}")
    print(f"\nwrote {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--blocks", type=int, default=2048)
    args = parser.parse_args()
    main(args.blocks)
