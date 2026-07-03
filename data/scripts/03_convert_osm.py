#!/usr/bin/env python3
"""Convert raw Overpass JSON (from 02_download_osm.py) into GeoJSON.

- Ways -> LineString features with a small 'tier' classification.
- Lake Ontario relation -> shoreline polygon: all 'outer' member ways are
  stitched into the lake's closed outer ring, 'inner' rings (islands) near
  Toronto are added as holes, then the result is clipped by mapshaper in
  04_process.sh.

Outputs intermediate GeoJSON into raw/ (final simplification/clipping happens
in 04_process.sh).
Usage: python3 03_convert_osm.py
"""
import json
import os

DATA_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(DATA_DIR, "raw")

# Extended bbox used to decide which island rings to keep (deg).
# Matches the GTA download extent in 02_download_osm.py.
EXT_W, EXT_S, EXT_E, EXT_N = -79.85, 43.45, -78.90, 43.98


def load(name):
    with open(os.path.join(RAW, name)) as f:
        return json.load(f)


def dump(fc, name):
    path = os.path.join(RAW, name)
    with open(path, "w") as f:
        json.dump(fc, f)
    print(f"{name}: {len(fc['features'])} features")


def ways_to_lines(data, keep_tags, tier_fn, extra_props_fn=None):
    feats = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        coords = [[n["lon"], n["lat"]] for n in el.get("geometry", [])]
        if len(coords) < 2:
            continue
        tags = el.get("tags", {})
        props = {t: tags[t] for t in keep_tags if t in tags}
        props["tier"] = tier_fn(tags)
        if extra_props_fn:
            props.update(extra_props_fn(tags))
        feats.append({"type": "Feature",
                      "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": props})
    return {"type": "FeatureCollection", "features": feats}


def waterway_buried(tags):
    """True when OSM marks the watercourse as buried/culverted:
    tunnel=culvert / tunnel=yes / tunnel=building_passage or
    location=underground (e.g. Castle Frank Brook)."""
    return (tags.get("tunnel") in ("culvert", "yes", "building_passage")
            or tags.get("location") == "underground")


# ---------------------------------------------------------------- lake ------

def stitch_rings(members):
    """Stitch way geometries (lists of {lat,lon}) into closed rings by
    matching endpoints. Returns list of rings ([[lon,lat], ...], closed)."""
    segs = []
    for m in members:
        pts = [(p["lon"], p["lat"]) for p in m.get("geometry", []) if p]
        if len(pts) >= 2:
            segs.append(pts)

    rings = []
    while segs:
        chain = list(segs.pop())
        extended = True
        while extended and chain[0] != chain[-1]:
            extended = False
            for i, s in enumerate(segs):
                if s[0] == chain[-1]:
                    chain += s[1:]
                elif s[-1] == chain[-1]:
                    chain += list(reversed(s))[1:]
                elif s[-1] == chain[0]:
                    chain = s[:-1] + chain
                elif s[0] == chain[0]:
                    chain = list(reversed(s))[:-1] + chain
                else:
                    continue
                segs.pop(i)
                extended = True
                break
        if chain[0] == chain[-1] and len(chain) >= 4:
            rings.append([[x, y] for x, y in chain])
        # open chains (data gaps) are dropped
    return rings


def ring_touches_ext_bbox(ring):
    return any(EXT_W <= x <= EXT_E and EXT_S <= y <= EXT_N for x, y in ring)


def build_lake(data):
    rel = next(e for e in data["elements"] if e["type"] == "relation")
    outers = [m for m in rel.get("members", []) if m.get("role") == "outer"]
    inners = [m for m in rel.get("members", []) if m.get("role") == "inner"]

    outer_rings = stitch_rings(outers)
    outer_rings.sort(key=len, reverse=True)
    if not outer_rings:
        raise SystemExit("Lake: no closed outer ring could be stitched")
    shell = outer_rings[0]  # the lake's full outer ring

    holes = [r for r in stitch_rings(inners) if ring_touches_ext_bbox(r)]
    print(f"Lake: outer ring {len(shell)} pts, {len(holes)} island holes near Toronto")

    feat = {"type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [shell] + holes},
            "properties": {"name": "Lake Ontario", "kind": "lake"}}
    return {"type": "FeatureCollection", "features": [feat]}


# ---------------------------------------------------------------- main ------

def main():
    # Rail: mainline vs spur/yard trackage.
    dump(ways_to_lines(
        load("osm-rail-raw.json"),
        keep_tags=[],
        tier_fn=lambda t: "spur" if t.get("service") in ("spur", "yard", "siding")
                          else "rail"),
        "osm-rail.geojson")

    # Waterways: keep name for labels; rivers vs everything else.
    # buried=true/false marks culverted/underground segments (tunnel=* tags).
    dump(ways_to_lines(
        load("osm-waterways-raw.json"),
        keep_tags=["name", "waterway"],
        tier_fn=lambda t: "river" if t.get("waterway") == "river" else "stream",
        extra_props_fn=lambda t: {"buried": waterway_buried(t)}),
        "osm-waterways.geojson")

    # Major streets: motorway/trunk vs primary/secondary. Keep names.
    dump(ways_to_lines(
        load("osm-streets-major-raw.json"),
        keep_tags=["name", "ref"],
        tier_fn=lambda t: "motorway"
        if t.get("highway", "").startswith(("motorway", "trunk"))
        else "major"),
        "osm-streets-major.geojson")

    # Minor streets: quiet context only, no names needed.
    dump(ways_to_lines(
        load("osm-streets-minor-raw.json"),
        keep_tags=[],
        tier_fn=lambda t: "minor"),
        "osm-streets-minor.geojson")

    # Lake Ontario polygon.
    dump(build_lake(load("osm-lake-raw.json")), "osm-lake.geojson")


if __name__ == "__main__":
    main()
