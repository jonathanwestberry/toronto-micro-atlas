"""Build FG04 point classes and paired named-street hourly profiles.

This script reads the completed Phase 2 rasters. It does not rebuild shade and
does not touch the immutable v3 tile bytes. Classification tiles are staged
under ``data/processed`` for upload to their own ``class/v1`` R2 prefix.

Usage: python 37_fg04_explorer.py [--class-only | --streets-only] [--limit N]
"""

import argparse
import json
import os
from pathlib import Path
import time
import warnings

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds
from rasterio.windows import Window
from shapely.geometry import LineString

import fg04_canopy as canopy
import fg04_explorer as explorer
import fg04_pyramid as pyramid

HERE = Path(__file__).resolve().parent
DATA = HERE.parent
ROOT = DATA.parent
PROCESSED = DATA / "processed" / "fg04"
RAW = DATA / "raw"
PUBLIC = ROOT / "public" / "data" / "fg04"
PUBLIC_DATA = ROOT / "public" / "data"
LAND_COVER = RAW / "fg04" / "landcover" / "LandCover2018.gdb"
GROUND_RASTER = PROCESSED / "ground.tif"
CLASS_RASTER = PROCESSED / "point-class-v1.tif"
GROUND_FRACTION = PROCESSED / "ground-fraction.tif"
COVERAGE_FRACTION = PROCESSED / "point-coverage-fraction.tif"
CANOPY_FRACTION = PROCESSED / "point-canopy-fraction.tif"
CLASS_TILES = PROCESSED / f"class-tiles-{explorer.CLASS_VERSION}"
STREET_PROFILES = PUBLIC / "street-profiles.json"
MANIFEST = PUBLIC / "manifest.json"
BOUNDARY = ROOT / "public" / "data" / "toronto-boundary.geojson"
OSM_INPUTS = (
    RAW / "osm-streets-major-raw.json",
    RAW / "osm-streets-minor-raw.json",
)

WEB_MERCATOR = "EPSG:3857"
MERCATOR_SPAN = 20037508.342789244
ANCHORS = {
    "York Street": {"measured": 11.70, "corrected": 11.74},
}


def read_band(source, *args, **kwargs):
    """Read through Rasterio while silencing one known NumPy 2.5 warning."""
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Setting the shape on a NumPy array has been deprecated.*",
            category=DeprecationWarning,
        )
        return source.read(*args, **kwargs)


def input_mtime(path: Path) -> int:
    if path.is_dir():
        return max([path.stat().st_mtime_ns] + [
            child.stat().st_mtime_ns for child in path.rglob("*")
            if child.is_file()
        ])
    return path.stat().st_mtime_ns


def derivative_is_current(path: Path, sources) -> bool:
    if not path.exists() or not all(Path(source).exists() for source in sources):
        return False
    return path.stat().st_mtime_ns >= max(
        input_mtime(Path(source)) for source in sources)


def point_class_sources():
    return [GROUND_RASTER, LAND_COVER, Path(canopy.__file__)]


def point_class_is_current() -> bool:
    if not derivative_is_current(CLASS_RASTER, point_class_sources()):
        return False
    with rasterio.open(CLASS_RASTER) as source:
        return source.tags().get(
            "fg04_class_algorithm") == explorer.POINT_CLASS_ALGORITHM


def build_point_class_raster() -> Path:
    """Write the exact native-grid class used by tiles and street profiles."""
    if point_class_is_current():
        print(f"point class raster current: {CLASS_RASTER}")
        return CLASS_RASTER

    started = time.time()
    cover = gpd.read_file(
        LAND_COVER, layer="LandCover2018", columns=["gridcode"])
    trees = cover[cover["gridcode"] == canopy.TREE_CODE].reset_index(drop=True)

    temporary = CLASS_RASTER.with_suffix(".tif.tmp")
    try:
        with rasterio.open(GROUND_RASTER) as source:
            trees = trees.to_crs(source.crs)
            tree_index = trees.sindex
            profile = source.profile.copy()
            profile.update(dtype="uint8", nodata=None, compress="deflate",
                           predictor=2, tiled=True, blockxsize=512,
                           blockysize=512, BIGTIFF="YES")
            with rasterio.open(temporary, "w", **profile) as sink:
                sink.update_tags(
                    fg04_class_algorithm=explorer.POINT_CLASS_ALGORITHM)
                blocks = list(source.block_windows(1))
                for position, (_, window) in enumerate(blocks, start=1):
                    values = read_band(source, 1, window=window)
                    transform = rasterio.windows.transform(
                        window, source.transform)
                    bounds = rasterio.windows.bounds(window, source.transform)
                    hits = list(tree_index.intersection(bounds))
                    nearby = trees.iloc[hits]
                    under_canopy = canopy.class_mask(
                        nearby, {canopy.TREE_CODE}, values.shape,
                        transform, source.crs)
                    classes = explorer.classify_pixels(
                        values != source.nodata, values == 1, under_canopy)
                    sink.write(classes, 1, window=window)
                    if position % 25 == 0 or position == len(blocks):
                        print(f"  class block {position}/{len(blocks)}",
                              flush=True)
        os.replace(temporary, CLASS_RASTER)
    finally:
        if temporary.exists():
            temporary.unlink()
    print(f"point class raster: {time.time() - started:.0f} s", flush=True)
    return CLASS_RASTER


def mercator_resolution(zoom: int) -> float:
    return 2.0 * MERCATOR_SPAN / (1 << zoom) / pyramid.TILE_SIZE


def build_class_fraction_raster(path: Path, predicate) -> Path:
    """Write a 0 or 255 fraction source with no nodata for area averaging."""
    if derivative_is_current(path, [CLASS_RASTER]):
        return path
    temporary = path.with_suffix(".tif.tmp")
    try:
        with rasterio.open(CLASS_RASTER) as source:
            profile = source.profile.copy()
            profile.update(dtype="uint8", nodata=None, compress="deflate",
                           predictor=2, tiled=True, blockxsize=512,
                           blockysize=512, BIGTIFF="YES")
            with rasterio.open(temporary, "w", **profile) as sink:
                for _, window in source.block_windows(1):
                    classes = read_band(source, 1, window=window)
                    values = np.where(predicate(classes), 255, 0).astype(np.uint8)
                    sink.write(values, 1, window=window)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return path


def classification_fraction_sources():
    if not GROUND_FRACTION.exists():
        raise RuntimeError(
            "ground-fraction.tif is missing; recover the shipped derivative "
            "without rebuilding v3")
    coverage = build_class_fraction_raster(
        COVERAGE_FRACTION, lambda classes: classes != explorer.MISSING)
    canopy_fraction = build_class_fraction_raster(
        CANOPY_FRACTION, lambda classes: classes == explorer.UNDER_CANOPY)
    return coverage, GROUND_FRACTION, canopy_fraction


def class_tile_path(zoom: int, x: int, y: int) -> Path:
    return CLASS_TILES / str(zoom) / str(x) / f"{y}.{pyramid.TILE_FORMAT}"


def write_class_tile(path: Path, classes: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pixels = explorer.encode_class_tile(classes)
    Image.fromarray(pixels, mode="RGB").save(
        path, format="WEBP", lossless=True, quality=100, method=2)


def read_class_tile(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        pixels = np.asarray(image.convert("RGB"))
    return explorer.decode_class_tile(pixels, verify=True)


def build_native_class_tiles(bounds, limit=None) -> int:
    """Build z16 from the same majority-ground rule as shipped v3."""
    zoom = pyramid.MAX_ZOOM
    started = time.time()
    resolution = mercator_resolution(zoom)
    x0, y0, x1, y1 = pyramid.tile_range(bounds, zoom)
    size = pyramid.TILE_SIZE
    transform = rasterio.transform.from_origin(
        -MERCATOR_SPAN + x0 * size * resolution,
        MERCATOR_SPAN - y0 * size * resolution,
        resolution, resolution)
    width = (x1 - x0 + 1) * size
    height = (y1 - y0 + 1) * size
    count = 0
    coverage_path, ground_path, canopy_path = classification_fraction_sources()
    with rasterio.open(coverage_path) as coverage_source, \
            rasterio.open(ground_path) as ground_source, \
            rasterio.open(canopy_path) as canopy_source, \
            WarpedVRT(coverage_source, crs=WEB_MERCATOR,
                      transform=transform, width=width, height=height,
                      resampling=Resampling.average) as coverage_warped, \
            WarpedVRT(ground_source, crs=WEB_MERCATOR,
                      transform=transform, width=width, height=height,
                      resampling=Resampling.average) as ground_warped, \
            WarpedVRT(canopy_source, crs=WEB_MERCATOR,
                      transform=transform, width=width, height=height,
                      resampling=Resampling.average) as canopy_warped:
        for x, y in pyramid.tiles_for_bounds(bounds, zoom):
            window = Window((x - x0) * size, (y - y0) * size, size, size)
            coverage = read_band(coverage_warped, 1, window=window) >= 128
            ground = read_band(ground_warped, 1, window=window) >= 128
            under_canopy = read_band(canopy_warped, 1, window=window) >= 128
            classes = explorer.classify_pixels(
                coverage, ground, under_canopy)
            write_class_tile(class_tile_path(zoom, x, y), classes)
            count += 1
            if limit and count >= limit:
                break
    print(f"z{zoom} class: {count:,} files, {time.time() - started:.0f} s",
          flush=True)
    return count


def aggregate_class_zoom(bounds, zoom: int) -> int:
    """Build one overview level from four exact children per parent tile."""
    started = time.time()
    size = pyramid.TILE_SIZE
    count = 0
    for x, y in pyramid.tiles_for_bounds(bounds, zoom):
        children = np.full((size * 2, size * 2), explorer.MISSING,
                           dtype=np.uint8)
        for offset_y in range(2):
            for offset_x in range(2):
                path = class_tile_path(
                    zoom + 1, x * 2 + offset_x, y * 2 + offset_y)
                if not path.exists():
                    continue
                child = read_class_tile(path)
                children[offset_y * size:(offset_y + 1) * size,
                         offset_x * size:(offset_x + 1) * size] = child
        parent = explorer.downsample_classes(children)
        write_class_tile(class_tile_path(zoom, x, y), parent)
        count += 1
    print(f"z{zoom} class: {count:,} files, {time.time() - started:.0f} s",
          flush=True)
    return count


def build_class_tiles(limit=None) -> dict:
    """Build z16 from source, then exact tested majorities through z12."""
    source_path = build_point_class_raster()
    with rasterio.open(source_path) as source:
        bounds = transform_bounds(source.crs, "EPSG:4326", *source.bounds)

    written_by_zoom = {
        pyramid.MAX_ZOOM: build_native_class_tiles(
            bounds, limit=limit)
    }
    if not limit:
        for zoom in range(pyramid.MAX_ZOOM - 1, pyramid.MIN_ZOOM - 1, -1):
            written_by_zoom[zoom] = aggregate_class_zoom(bounds, zoom)

    paths = [path for path in CLASS_TILES.rglob("*.webp")]
    for path in paths:
        pyramid.check_file_sizes([path])
    return {
        "bounds": list(bounds),
        "written": len(paths),
        "bytes": sum(path.stat().st_size for path in paths),
        "byZoom": {str(zoom): value
                   for zoom, value in sorted(written_by_zoom.items())},
    }


def osm_features():
    """Yield named OSM ways as Shapely lines, retaining their source tags."""
    for path in OSM_INPUTS:
        with path.open() as handle:
            document = json.load(handle)
        for element in document.get("elements", []):
            coordinates = [
                (point["lon"], point["lat"])
                for point in element.get("geometry", [])
                if "lon" in point and "lat" in point
            ]
            if len(coordinates) < 2:
                continue
            line = LineString(coordinates)
            if not line.is_empty and line.length > 0:
                yield {"tags": element.get("tags", {}), "geometry": line}


def named_streets(crs) -> gpd.GeoDataFrame:
    """Group, clip and length-filter the declared explorer street grain."""
    started = time.time()
    groups = explorer.group_named_streets(osm_features())
    frame = gpd.GeoDataFrame(
        {"id": [group.id for group in groups],
         "name": [group.name for group in groups],
         "geometry": [group.geometry for group in groups]},
        crs="EPSG:4326")
    city = gpd.read_file(BOUNDARY).to_crs("EPSG:4326").union_all()
    frame["geometry"] = frame.geometry.intersection(city)
    frame = frame[~frame.geometry.is_empty].to_crs(crs).reset_index(drop=True)
    frame["length_m"] = frame.length
    frame = frame[
        frame["length_m"] >= explorer.MINIMUM_STREET_LENGTH_M
    ].sort_values(["name", "id"], key=lambda series: series.str.casefold()
             if series.dtype == object else series).reset_index(drop=True)
    frame["zone"] = np.arange(1, len(frame) + 1, dtype=np.int32)
    print(f"named streets: {len(frame):,} groups in "
          f"{time.time() - started:.0f} s", flush=True)
    return frame


def burn_street_block(bands, spatial_index, bounds, shape, transform,
                      preserve_source_order=False):
    hits = list(spatial_index.intersection(bounds))
    if not hits:
        return np.zeros(shape, dtype=np.int32)
    if not preserve_source_order:
        hits.sort(key=lambda index: int(bands.zone.iloc[index]))
    shapes = [(bands.geometry.iloc[index], int(bands.zone.iloc[index]))
              for index in hits]
    return rasterize(shapes, out_shape=shape, transform=transform,
                     fill=0, dtype="int32")


def accumulate_street_profiles(streets: gpd.GeoDataFrame):
    """Accumulate both surfaces blockwise against one named-street label grid."""
    bands = gpd.GeoDataFrame(
        {"zone": streets["zone"],
         "geometry": [explorer.walking_band(value)
                      for value in streets.geometry]},
        crs=streets.crs)
    spatial_index = bands.sindex
    zones = len(streets) + 1
    ground_pixels = np.zeros(zones, dtype=np.int64)
    shaded = {
        surface: np.zeros((zones, 15), dtype=np.int64)
        for surface in pyramid.SURFACES
    }

    handles = [rasterio.open(CLASS_RASTER)]
    classes_source = handles[0]
    sources = {
        surface: rasterio.open(PROCESSED / f"shade-{surface}.tif")
        for surface in pyramid.SURFACES
    }
    handles.extend(sources.values())
    try:
        blocks = list(classes_source.block_windows(1))
        for position, (_, window) in enumerate(blocks, start=1):
            classes = read_band(classes_source, 1, window=window)
            transform = rasterio.windows.transform(
                window, classes_source.transform)
            bounds = rasterio.windows.bounds(window, classes_source.transform)
            labels = burn_street_block(
                bands, spatial_index, bounds, classes.shape, transform)
            ground = (classes >= explorer.GROUND) & (labels > 0)
            if ground.any():
                ground_pixels += np.bincount(
                    labels[ground], minlength=zones).astype(np.int64)
                for surface, source in sources.items():
                    bits = read_band(source, 1, window=window)
                    if surface == "corrected":
                        bits = np.where(
                            classes == explorer.UNDER_CANOPY,
                            explorer.ALL_HOURS, bits).astype(np.uint16)
                    for bit in range(15):
                        selected = ground & (((bits >> bit) & 1) == 1)
                        shaded[surface][:, bit] += np.bincount(
                            labels[selected], minlength=zones).astype(np.int64)
            if position % 25 == 0 or position == len(blocks):
                print(f"  street block {position}/{len(blocks)}", flush=True)
    finally:
        for handle in handles:
            handle.close()
    return ground_pixels, shaded


def fractions(counts, denominator):
    if denominator == 0:
        return [None] * 15
    return [round(float(value) / denominator, 6) for value in counts]


def phase2_street_segments(crs) -> gpd.GeoDataFrame:
    """Load the exact Phase 2 arterial and unnamed-minor label competition."""
    boundary = gpd.read_file(BOUNDARY).to_crs(crs).union_all()
    major = gpd.read_file(PUBLIC_DATA / "streets-major.geojson").to_crs(crs)
    arterial = major[major["tier"] == "major"].reset_index(drop=True)
    minor = gpd.read_file(PUBLIC_DATA / "streets-minor.geojson").to_crs(crs)
    minor = minor.explode(index_parts=False).reset_index(drop=True)
    arterial = arterial.clip(boundary)
    minor = minor.clip(boundary)
    arterial = arterial[~arterial.geometry.is_empty].reset_index(drop=True)
    minor = minor[~minor.geometry.is_empty].reset_index(drop=True)
    segments = gpd.GeoDataFrame(
        {"name": list(arterial["name"]) + [None] * len(minor),
         "kind": ["arterial"] * len(arterial) + ["minor"] * len(minor),
         "geometry": list(arterial.geometry) + list(minor.geometry)},
        crs=crs)
    segments["zone"] = np.arange(1, len(segments) + 1, dtype=np.int32)
    return segments


def phase2_anchor_profiles() -> dict:
    """Reproduce only the matching-grain York anchor, not Phase 2 statistics."""
    with rasterio.open(CLASS_RASTER) as classes_source:
        crs = classes_source.crs
        transform = classes_source.transform
        width, height = classes_source.width, classes_source.height
    segments = phase2_street_segments(crs)
    target = np.flatnonzero(
        (segments["kind"].to_numpy() == "arterial")
        & (segments["name"].to_numpy() == "York Street"))
    if len(target) != 1:
        raise RuntimeError(f"expected one Phase 2 York Street, found {len(target)}")
    zone = int(segments.iloc[int(target[0])]["zone"])
    bands = gpd.GeoDataFrame(
        {"zone": segments["zone"],
         "geometry": segments.buffer(explorer.OUTER_WALK_M).difference(
             segments.buffer(explorer.INNER_WALK_M))},
        crs=crs)
    spatial_index = bands.sindex
    ground_pixels = 0
    totals = {surface: np.zeros(15, dtype=np.int64)
              for surface in pyramid.SURFACES}
    handles = [rasterio.open(CLASS_RASTER)]
    sources = {surface: rasterio.open(PROCESSED / f"shade-{surface}.tif")
               for surface in pyramid.SURFACES}
    handles.extend(sources.values())
    try:
        classes_source = handles[0]
        for row in range(0, height, 2048):
            for column in range(0, width, 2048):
                window = Window(column, row, min(2048, width - column),
                                min(2048, height - row))
                classes = read_band(classes_source, 1, window=window)
                window_transform = rasterio.windows.transform(window, transform)
                bounds = rasterio.windows.bounds(window, transform)
                labels = burn_street_block(
                    bands, spatial_index, bounds, classes.shape,
                    window_transform, preserve_source_order=True)
                ground = (classes >= explorer.GROUND) & (labels == zone)
                ground_pixels += int(ground.sum())
                for surface, source in sources.items():
                    bits = read_band(source, 1, window=window)
                    if surface == "corrected":
                        bits = np.where(
                            classes == explorer.UNDER_CANOPY,
                            explorer.ALL_HOURS, bits).astype(np.uint16)
                    for bit in range(15):
                        totals[surface][bit] += int(
                            (ground & (((bits >> bit) & 1) == 1)).sum())
    finally:
        for handle in handles:
            handle.close()
    return {"measured": fractions(totals["raw"], ground_pixels),
            "corrected": fractions(totals["corrected"], ground_pixels),
            "groundPixels": ground_pixels,
            "centerlineM": round(float(
                segments.iloc[int(target[0])].geometry.length), 1)}


def validate_anchors() -> dict:
    """Pin a matching-grain Phase 2 profile to published Phase 0 evidence."""
    profiles = phase2_anchor_profiles()
    evidence = {}
    for name, expected in ANCHORS.items():
        evidence[name] = {
            "grain": "Phase 2 arterial with 8 to 15 m walking band",
            "centerlineM": profiles["centerlineM"],
            "groundPixels": profiles["groundPixels"],
        }
        for record_key in ("measured", "corrected"):
            actual = round(sum(profiles[record_key]), 2)
            target = expected[record_key]
            if abs(actual - target) > 0.01:
                raise RuntimeError(
                    f"{name} {record_key} profile sums to {actual:.2f}; "
                    f"published anchor is {target:.2f}")
            evidence[name][record_key] = {
                "publishedMeanShadedFrames": target,
                "profileFractionSum": actual,
            }
    return evidence


def build_street_profiles() -> dict:
    build_point_class_raster()
    with rasterio.open(CLASS_RASTER) as source:
        crs = source.crs
    streets = named_streets(crs)
    ground_pixels, shaded = accumulate_street_profiles(streets)

    center_points = streets.geometry.representative_point()
    centers = gpd.GeoSeries(center_points, crs=streets.crs).to_crs("EPSG:4326")
    records = []
    for index, row in streets.iterrows():
        zone = int(row["zone"])
        center = centers.iloc[index]
        records.append({
            "id": row["id"],
            "name": row["name"],
            "center": [round(float(center.x), 6), round(float(center.y), 6)],
            "lengthM": round(float(row["length_m"]), 1),
            "groundPixels": int(ground_pixels[zone]),
            "measured": fractions(shaded["raw"][zone], ground_pixels[zone]),
            "corrected": fractions(
                shaded["corrected"][zone], ground_pixels[zone]),
        })
    anchor_evidence = validate_anchors()
    document = {
        "schemaVersion": 1,
        "modelledDate": pyramid.MODEL_DATE,
        "timezone": pyramid.TZ,
        "hours": list(range(6, 21)),
        "surfaceOrder": ["measured", "corrected"],
        "grain": {
            "source": "OpenStreetMap named ways",
            "included": "named walkable street features clipped to Toronto",
            "excludedHighways": sorted(explorer.EXCLUDED_HIGHWAYS),
            "minimumCenterlineM": explorer.MINIMUM_STREET_LENGTH_M,
            "walkingBandM": {
                "inner": explorer.INNER_WALK_M,
                "outer": explorer.OUTER_WALK_M,
            },
            "grouping": "normalized displayed name",
            "overlapRule": (
                "one deterministic street label per pixel; the later stable "
                "street id owns an intersection overlap"),
        },
        "anchorEvidence": anchor_evidence,
        "streets": records,
    }
    PUBLIC.mkdir(parents=True, exist_ok=True)
    STREET_PROFILES.write_text(
        json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n")
    pyramid.check_file_sizes([STREET_PROFILES])
    print(f"street profiles: {len(records):,} records, "
          f"{STREET_PROFILES.stat().st_size / 1e6:.1f} MB")
    return {"count": len(records), "bytes": STREET_PROFILES.stat().st_size,
            "anchorEvidence": anchor_evidence}


def update_manifest(class_summary: dict, street_summary: dict) -> None:
    document = json.loads(MANIFEST.read_text())
    document["countAggregation"] = (
        "mean of the four children, rounded ties to even. The mask aggregates "
        "by majority vote per bit, which cannot preserve the mean count, so "
        "above the native zoom the count channel is the unbiased average and "
        "the mask is the best per-bit answer.")
    document["classification"] = {
        "version": explorer.CLASS_VERSION,
        "tileUrlTemplate": explorer.classification_tile_url(),
        "localTileUrlTemplate": explorer.classification_tile_url(
            explorer.CLASS_LOCAL_BASE_URL),
        "channel": "red",
        "reservedChannels": ["green", "blue"],
        "values": {str(key): value
                   for key, value in explorer.CLASS_NAMES.items()},
        "aggregation": (
            "majority coverage, then majority ground, then majority canopy "
            "among ground; a canopy tie remains canopy"),
        "tilesWritten": class_summary["written"],
        "tilesWrittenByZoom": class_summary["byZoom"],
        "bytesTotal": class_summary["bytes"],
        "classBandStarts": {
            str(value): pyramid.dem_value(value)
            for value in range(explorer.UNDER_CANOPY + 2)
        },
    }
    document["streetProfiles"] = {
        "url": "/data/fg04/street-profiles.json",
        "schemaVersion": 1,
        "records": street_summary["count"],
        "bytes": street_summary["bytes"],
        "anchorEvidence": street_summary["anchorEvidence"],
    }
    MANIFEST.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    pyramid.check_file_sizes([MANIFEST])


def existing_class_summary() -> dict:
    paths = list(CLASS_TILES.rglob("*.webp"))
    by_zoom = {}
    for path in paths:
        zoom = path.relative_to(CLASS_TILES).parts[0]
        by_zoom[zoom] = by_zoom.get(zoom, 0) + 1
    return {"written": len(paths),
            "bytes": sum(path.stat().st_size for path in paths),
            "byZoom": dict(sorted(by_zoom.items()))}


def existing_street_summary() -> dict:
    document = json.loads(STREET_PROFILES.read_text())
    return {"count": len(document["streets"]),
            "bytes": STREET_PROFILES.stat().st_size,
            "anchorEvidence": document["anchorEvidence"]}


def main(class_only=False, streets_only=False, limit=None) -> None:
    if class_only and streets_only:
        raise SystemExit("choose at most one of --class-only and --streets-only")
    class_summary = (existing_class_summary() if streets_only
                     else build_class_tiles(limit=limit))
    if limit:
        print("limited class proof complete; manifest was not changed")
        return
    street_summary = (existing_street_summary() if class_only
                      else build_street_profiles())
    update_manifest(class_summary, street_summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--class-only", action="store_true")
    parser.add_argument("--streets-only", action="store_true")
    parser.add_argument("--limit", type=int)
    arguments = parser.parse_args()
    main(class_only=arguments.class_only,
         streets_only=arguments.streets_only,
         limit=arguments.limit)
