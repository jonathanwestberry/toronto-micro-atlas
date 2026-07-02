#!/usr/bin/env bash
# Process raw layers into web-ready WGS84 GeoJSON in processed/.
# Requires: node/npx (mapshaper is fetched by npx on first run).
#
# Simplification notes:
#   * mapshaper -simplify with a bare number/percentage keeps that PROPORTION
#     of removable vertices (weighted Visvalingam). Percentages below were
#     tuned empirically for zooms ~10-15 and a <3 MB per-file budget.
#   * keep-shapes prevents small rings from collapsing entirely.
#   * precision=0.00001 writes 5 decimal places (~1.1 m), plenty for z15.
#
# Usage: bash 04_process.sh
set -euo pipefail

DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RAW="${DATA_DIR}/raw"
PROC="${DATA_DIR}/processed"
SCRIPTS="${DATA_DIR}/scripts"
mkdir -p "${PROC}"

# Toronto extent with a small buffer (W,S,E,N)
BBOX="-79.66,43.56,-79.09,43.88"
MS="npx mapshaper"
PREC="precision=0.00001"

echo "== 1. Hidden landscape: RNFP ravine system (dissolved to one multipolygon) =="
$MS "${RAW}/rnfp-shp/RAVINE_BYLAW_WGS84_fixed.shp" \
  -each 'layer="rnfp"' \
  -dissolve 'layer' \
  -simplify 25% keep-shapes \
  -clean \
  -filter-slivers min-area=400m2 \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/ravine-rnfp.geojson"

echo "== 2. Green Spaces (parkland classes only) =="
$MS "${RAW}/green-spaces-4326.geojson" \
  -filter 'AREA_CLASS == "Park" || AREA_CLASS == "Open Green Space" || AREA_CLASS == "OTHER_TRCA" || AREA_CLASS == "OTHER_PROVINCIAL_FEDERAL" || AREA_CLASS == "Hydro Field/Utility Corridor"' \
  -filter-fields AREA_NAME,AREA_CLASS \
  -rename-fields name=AREA_NAME,class=AREA_CLASS \
  -simplify 15% keep-shapes \
  -clean \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/green-spaces.geojson"

echo "== 3. Parks (City parkland polygons) =="
$MS "${RAW}/parks-shp/CITY_GREEN_SPACE_WGS84.shp" \
  -filter-fields NAME,TYPE_DESC \
  -rename-fields name=NAME,type=TYPE_DESC \
  -simplify 15% keep-shapes \
  -clean \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/parks-city.geojson"

echo "== 4. Environmentally Significant Areas =="
$MS "${RAW}/esa-4326.geojson" \
  -filter-fields ESA_NAME \
  -rename-fields name=ESA_NAME \
  -simplify 30% keep-shapes \
  -clean \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/esa.geojson"

echo "== 5. Lake Ontario shoreline polygon (clip first: source ring spans the whole lake) =="
$MS "${RAW}/osm-lake.geojson" \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -simplify interval=0.00004 keep-shapes \
  -clean \
  -o format=geojson $PREC "${PROC}/lake-ontario.geojson"

echo "== 6. Watercourses (rivers & creeks; drains/ditches dropped; buried flag kept) =="
$MS "${RAW}/osm-waterways.geojson" \
  -filter 'waterway == "river" || waterway == "stream" || waterway == "canal"' \
  -filter-fields name,tier,buried \
  -simplify 30% \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/watercourses.geojson"

echo "== 7. Major streets (motorway/trunk vs primary/secondary), merged per street name =="
$MS "${RAW}/osm-streets-major.geojson" \
  -filter-fields name,ref,tier \
  -simplify 25% \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -dissolve 'tier,name' copy-fields=ref \
  -o format=geojson $PREC "${PROC}/streets-major.geojson"

echo "== 8. Minor streets (dissolved context linework, no attributes) =="
$MS "${RAW}/osm-streets-minor.geojson" \
  -simplify 25% \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -dissolve 'tier' \
  -o format=geojson $PREC "${PROC}/streets-minor.geojson"

echo "== 9. Rail lines (mainline vs spur/yard) =="
$MS "${RAW}/osm-rail.geojson" \
  -simplify 30% \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -dissolve 'tier' \
  -o format=geojson $PREC "${PROC}/rail.geojson"

echo "== 10. Orientation labels (handcrafted, validated through mapshaper) =="
$MS "${SCRIPTS}/orientation_labels.geojson" \
  -o format=geojson "${PROC}/orientation-labels.geojson"

echo "== 11. Strip null/empty-geometry features (created at write time by precision quantization) =="
export PROC_DIR="${PROC}"
python3 - <<'PYEOF'
import json, glob, os
for path in sorted(glob.glob(os.path.join(os.environ["PROC_DIR"], "*.geojson"))):
    with open(path) as f:
        d = json.load(f)
    before = len(d["features"])
    d["features"] = [ft for ft in d["features"]
                     if ft.get("geometry") and ft["geometry"].get("coordinates")]
    if len(d["features"]) != before:
        with open(path, "w") as f:
            json.dump(d, f, separators=(",", ":"))
        print(f"{os.path.basename(path)}: dropped {before - len(d['features'])} null/empty-geometry features")
PYEOF

echo "== Done. Outputs: =="
ls -lh "${PROC}"
