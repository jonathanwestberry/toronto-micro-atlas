#!/usr/bin/env python3
"""Process the raw street tree inventory into FG02 build inputs.

Reads data/raw/street-trees-4326.geojson (688k points, City of Toronto
Open Data "Street Tree Data") and writes:

  data/processed/trees-tiling.ndjson   one feature per line for tippecanoe
  public/data/fg02/meta.json           species lookup, categories, stats
  public/data/fg02/streets.json        street name -> centroid search index

Feature attributes are minimized for tile size:
  g  genus category index (see CATEGORIES)
  s  species index into meta.json species array (ordered by count desc)
  d  trunk diameter in cm (omitted when missing or implausible)
  a  civic address string for the tap popup
"""

import json
import os
import re
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw", "street-trees-4326.geojson")
PROCESSED = os.path.join(ROOT, "processed")
PUBLIC_FG02 = os.path.join(os.path.dirname(ROOT), "public", "data", "fg02")

# Genus category assignment. Order is the legend order: the four story
# genera lead, groups follow, ash sits low (its chapter explains why),
# "other" last.
CONIFERS = {
    "Picea", "Pinus", "Abies", "Thuja", "Tsuga", "Larix", "Juniperus",
    "Taxodium", "Metasequoia", "Chamaecyparis", "Pseudotsuga", "Cedrus",
    "Taxus", "Cupressus",
}
FLOWERING = {
    "Malus", "Syringa", "Prunus", "Amelanchier", "Pyrus", "Crataegus",
    "Cornus", "Magnolia", "Cercis", "Hibiscus", "Viburnum", "Hamamelis",
    "Maackia",
}

# Category colors are the single source of truth for the whole guide:
# the PNG renders (13_render_trees.py), the MapLibre circle layers, and
# the legend all read them from meta.json. Validated against the ground
# #0D1721 (all >= 3:1). Ash is deliberately ashen and "everything else"
# deliberately recedes; identity is never color-alone (legend isolation,
# chapter isolation, and tap-to-identify are the secondary encodings).
CATEGORIES = [
    ("maple", "Maple", "#EB6F5C"),
    ("locust", "Honey locust", "#CDE052"),
    ("oak", "Oak", "#E68333"),
    ("linden", "Linden", "#73CAA1"),
    ("conifer", "Conifers", "#4ABBBF"),
    ("elm", "Elm", "#DB98E1"),
    ("coffeetree", "Kentucky coffeetree", "#61B3E5"),
    ("flowering", "Flowering trees", "#F292B8"),
    ("ginkgo", "Ginkgo", "#F8DC4F"),
    ("ash", "Ash", "#C7CCD1"),
    ("other", "Everything else", "#637388"),
]
CAT_INDEX = {key: i for i, (key, _, _) in enumerate(CATEGORIES)}


def categorize(genus: str) -> int:
    if genus == "Acer":
        return CAT_INDEX["maple"]
    if genus == "Gleditsia":
        return CAT_INDEX["locust"]
    if genus == "Quercus":
        return CAT_INDEX["oak"]
    if genus == "Tilia":
        return CAT_INDEX["linden"]
    if genus in CONIFERS:
        return CAT_INDEX["conifer"]
    if genus == "Ulmus":
        return CAT_INDEX["elm"]
    if genus == "Gymnocladus":
        return CAT_INDEX["coffeetree"]
    if genus in FLOWERING:
        return CAT_INDEX["flowering"]
    if genus == "Ginkgo":
        return CAT_INDEX["ginkgo"]
    if genus == "Fraxinus":
        return CAT_INDEX["ash"]
    return CAT_INDEX["other"]


SMALL_WORDS = {"of", "the"}


def title_address(address, street: str) -> str:
    """'67' + 'TORRANCE RD' -> '67 Torrance Rd' (best-effort casing)."""
    words = []
    for w in street.strip().split():
        lw = w.lower()
        if lw in SMALL_WORDS:
            words.append(lw)
        elif re.fullmatch(r"mc\w+", lw):
            words.append("Mc" + lw[2:].capitalize())
        else:
            words.append(lw.capitalize())
    name = " ".join(words)
    try:
        num = int(address)
    except (TypeError, ValueError):
        num = 0
    return f"{num} {name}" if num > 0 else name


def main() -> None:
    os.makedirs(PROCESSED, exist_ok=True)
    os.makedirs(PUBLIC_FG02, exist_ok=True)

    with open(RAW) as f:
        data = json.load(f)
    feats = data["features"]

    # Pass 1: species counts to build the index (small ints for common trees).
    species_counts = Counter()
    for ft in feats:
        p = ft["properties"]
        bot = (p.get("BOTANICAL_NAME") or "").strip()
        # Normalize the dataset's lowercase 'ginkgo biloba' rows.
        if bot and bot[0].islower():
            bot = bot[0].upper() + bot[1:]
        species_counts[bot] += 1

    species_order = [s for s, _ in species_counts.most_common()]
    species_index = {s: i for i, s in enumerate(species_order)}
    species_common: dict[str, str] = {}

    # Pass 2: emit tiling features, gather stats.
    cat_counts = Counter()
    ward_counts = Counter()
    street_pts = defaultdict(lambda: [0.0, 0.0, 0])
    singleton_feats = []
    n_written = 0

    out_path = os.path.join(PROCESSED, "trees-tiling.ndjson")
    with open(out_path, "w") as out:
        for ft in feats:
            p = ft["properties"]
            geom = ft.get("geometry")
            coords = (geom or {}).get("coordinates") or []
            # The city ships MultiPoint geometries holding a single position.
            if geom and geom.get("type") == "MultiPoint":
                coords = coords[0] if coords else []
            if len(coords) < 2:
                continue
            lng, lat = coords[:2]
            if not isinstance(lng, (int, float)) or not isinstance(lat, (int, float)):
                continue

            bot = (p.get("BOTANICAL_NAME") or "").strip()
            if bot and bot[0].islower():
                bot = bot[0].upper() + bot[1:]
            com = (p.get("COMMON_NAME") or "").strip()
            if bot not in species_common and com:
                species_common[bot] = com

            genus = bot.split(" ")[0] if bot else "?"
            cat = categorize(genus)
            cat_counts[cat] += 1

            ward = str(p.get("WARD") or "")
            if ward and ward != "None":
                ward_counts[ward] += 1

            street_raw = (p.get("STREETNAME") or "").strip()
            addr = title_address(p.get("ADDRESS"), street_raw)

            if street_raw:
                acc = street_pts[street_raw]
                acc[0] += lng
                acc[1] += lat
                acc[2] += 1

            props = {"g": cat, "s": species_index[bot], "a": addr}
            d = p.get("DBH_TRUNK")
            if isinstance(d, (int, float)) and 0 < d <= 250:
                props["d"] = int(d)

            out.write(json.dumps({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lng, 6), round(lat, 6)],
                },
                "properties": props,
            }, separators=(",", ":")) + "\n")
            n_written += 1

            if species_counts[bot] == 1 and " " in bot:
                singleton_feats.append({
                    "botanical": bot,
                    "common": com,
                    "lng": round(lng, 6),
                    "lat": round(lat, 6),
                    "address": addr,
                })

    # Street search index: [display name, lng, lat, count], name-sorted.
    streets = []
    for raw_name, (sx, sy, n) in street_pts.items():
        if n < 3:
            continue  # skip fragments; too few points to be a findable street
        streets.append([
            title_address(None, raw_name),
            round(sx / n, 5),
            round(sy / n, 5),
            n,
        ])
    streets.sort(key=lambda r: r[0])

    species_arr = [
        [s, species_common.get(s, s), categorize(s.split(" ")[0] if s else "?")]
        for s in species_order
    ]

    wards_sorted = ward_counts.most_common()
    meta = {
        "generated": "see data/README.md",
        "total": n_written,
        "distinctSpecies": len([s for s in species_counts if s]),
        "categories": [
            {"key": k, "label": lbl, "color": color, "count": cat_counts[CAT_INDEX[k]]}
            for k, lbl, color in CATEGORIES
        ],
        "species": species_arr,
        "stats": {
            "norwayMaple": species_counts.get("Acer platanoides", 0),
            "sugarMaple": species_counts.get("Acer saccharum", 0),
            "acerTotal": sum(c for s, c in species_counts.items() if s.startswith("Acer")),
            "honeyLocust": sum(c for s, c in species_counts.items() if s.startswith("Gleditsia")),
            "ginkgo": sum(c for s, c in species_counts.items() if s.startswith("Ginkgo")),
            "ash": sum(c for s, c in species_counts.items() if s.startswith("Fraxinus")),
            "lilac": sum(c for s, c in species_counts.items() if s.startswith("Syringa")),
            "wardMost": {"ward": wards_sorted[0][0], "count": wards_sorted[0][1]},
            "wardLeast": {"ward": wards_sorted[-1][0], "count": wards_sorted[-1][1]},
        },
        "singletons": sorted(singleton_feats, key=lambda s: s["botanical"]),
    }

    with open(os.path.join(PUBLIC_FG02, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    with open(os.path.join(PUBLIC_FG02, "streets.json"), "w") as f:
        json.dump(streets, f, separators=(",", ":"))

    print(f"features written: {n_written}")
    print(f"streets indexed:  {len(streets)}")
    print(f"singletons:       {len(singleton_feats)}")
    for key, lbl, _color in CATEGORIES:
        print(f"  {lbl:22s} {cat_counts[CAT_INDEX[key]]:>7,}")
    print("stats:", json.dumps(meta["stats"], indent=2))


if __name__ == "__main__":
    main()
