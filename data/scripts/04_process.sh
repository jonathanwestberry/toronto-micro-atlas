#!/usr/bin/env bash
# Process raw layers into web-ready WGS84 GeoJSON in processed/.
# Requires: node/npx (mapshaper is fetched by npx on first run).
#
# Simplification notes:
#   * mapshaper -simplify with a bare number/percentage keeps that PROPORTION
#     of removable vertices (weighted Visvalingam). Percentages below were
#     tuned empirically for zooms ~10-15 and a per-file budget.
#   * keep-shapes prevents small rings from collapsing entirely.
#   * precision=0.00001 writes 5 decimal places (~1.1 m), plenty for z15.
#
# Extents:
#   * BBOX (OSM context) is extended into the GTA so the map has no paper void
#     at the citywide floor. The map fits the eight markers, and the surrounding
#     street fabric / lake fills every edge instead of a wash-to-paper mask.
#   * BBOX_CITY keeps the subject layers (ravine, ESA, parks, boundary) clipped
#     to Toronto: that data only exists inside the city and IS the argument.
#   * BBOX_WATER keeps watercourses to Toronto + the Rouge: buried creeks are a
#     Toronto subject, and GTA-wide streams only add payload.
#   NOTE: re-run 02_download_osm.py with the matching GTA bbox before this.
#
# Usage: bash 04_process.sh
set -euo pipefail

DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RAW="${DATA_DIR}/raw"
PROC="${DATA_DIR}/processed"
SCRIPTS="${DATA_DIR}/scripts"
mkdir -p "${PROC}"

# OSM context extent (W,S,E,N). Lake keeps this wider extent so its south/E-W
# reach covers the min-zoom viewport on tall/wide screens with no colour edge.
BBOX="-79.85,43.45,-78.90,43.98"
# Streets: tighter. The camera clamps to the city-fit viewport at min zoom and
# the outside-wash covers anything past this, so far-GTA street fabric is dead
# weight. Trimmed E-W to the city + a margin (keeps all eight markers).
BBOX_STREETS="-79.75,43.45,-79.00,43.98"
# Watercourses: Toronto + the Rouge only.
BBOX_WATER="-79.72,43.55,-79.08,43.95"
# City subject layers: Toronto only (unchanged from the original build).
BBOX_CITY="-79.66,43.56,-79.09,43.88"
# Outside-wash rectangle: larger than any screen's min-zoom viewport, so beyond
# the real data it reads as uniform wash (never bare paper). W,S,E,N.
BBOX_WASH="-79.98,43.30,-78.72,44.12"
MS="npx mapshaper"
PREC="precision=0.00001"

echo "== 1. Hidden landscape: RNFP ravine system (dissolved to one multipolygon) =="
$MS "${RAW}/rnfp-shp/RAVINE_BYLAW_WGS84_fixed.shp" \
  -each 'layer="rnfp"' \
  -dissolve 'layer' \
  -simplify 25% keep-shapes \
  -clean \
  -filter-slivers min-area=400m2 \
  -clip bbox=${BBOX_CITY} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/ravine-rnfp.geojson"

echo "== 2. Green Spaces (parkland classes only) =="
$MS "${RAW}/green-spaces-4326.geojson" \
  -filter 'AREA_CLASS == "Park" || AREA_CLASS == "Open Green Space" || AREA_CLASS == "OTHER_TRCA" || AREA_CLASS == "OTHER_PROVINCIAL_FEDERAL" || AREA_CLASS == "Hydro Field/Utility Corridor"' \
  -filter-fields AREA_NAME,AREA_CLASS \
  -rename-fields name=AREA_NAME,class=AREA_CLASS \
  -simplify 15% keep-shapes \
  -clean \
  -clip bbox=${BBOX_CITY} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/green-spaces.geojson"

echo "== 3. Parks (City parkland polygons) =="
$MS "${RAW}/parks-shp/CITY_GREEN_SPACE_WGS84.shp" \
  -filter-fields NAME,TYPE_DESC \
  -rename-fields name=NAME,type=TYPE_DESC \
  -simplify 15% keep-shapes \
  -clean \
  -clip bbox=${BBOX_CITY} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/parks-city.geojson"

echo "== 4. Environmentally Significant Areas =="
$MS "${RAW}/esa-4326.geojson" \
  -filter-fields ESA_NAME \
  -rename-fields name=ESA_NAME \
  -simplify 30% keep-shapes \
  -clean \
  -clip bbox=${BBOX_CITY} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/esa.geojson"

echo "== 5. Lake Ontario shoreline polygon (clip first: source ring spans the whole lake) =="
$MS "${RAW}/osm-lake.geojson" \
  -clip bbox=${BBOX} \
  -filter remove-empty \
  -simplify interval=0.00006 keep-shapes \
  -clean \
  -o format=geojson $PREC "${PROC}/lake-ontario.geojson"

echo "== 6. Watercourses (rivers & creeks; drains/ditches dropped; buried flag kept) =="
$MS "${RAW}/osm-waterways.geojson" \
  -filter 'waterway == "river" || waterway == "stream" || waterway == "canal"' \
  -filter-fields name,tier,buried \
  -simplify 30% \
  -clip bbox=${BBOX_WATER} \
  -filter remove-empty \
  -o format=geojson $PREC "${PROC}/watercourses.geojson"

echo "== 7. Major streets (motorway/trunk vs primary/secondary), merged per street name =="
$MS "${RAW}/osm-streets-major.geojson" \
  -filter-fields name,ref,tier \
  -simplify 20% \
  -clip bbox=${BBOX_STREETS} \
  -filter remove-empty \
  -dissolve 'tier,name' copy-fields=ref \
  -o format=geojson $PREC "${PROC}/streets-major.geojson"

echo "== 8. Minor streets (dissolved context linework, no attributes) =="
# Heavier simplify (10%) than the subject layers: minor streets are hairline
# fabric at these zooms, and the GTA extent would otherwise be too heavy.
$MS "${RAW}/osm-streets-minor.geojson" \
  -simplify 10% \
  -clip bbox=${BBOX_STREETS} \
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

echo "== 11. Municipal boundary (dissolved to one polygon) =="
$MS "${RAW}/boundary-shp/citygcs_regional_mun_wgs84.shp" \
  -each 'layer="boundary"' \
  -dissolve 'layer' \
  -simplify 25% keep-shapes \
  -clean \
  -o format=geojson $PREC "${PROC}/toronto-boundary.geojson"

echo "== 12. Outside-survey wash (rectangle minus Toronto) =="
# A paper fill over everything beyond the boundary, mutes the GTA context to a
# faint ghost so Toronto reads as the figure. The rectangle is larger than any
# screen's min-zoom viewport (the camera clamps to that), so its outer edge is
# unreachable and no soft feather is needed (the old feather rings are gone).
$MS -rectangle bbox=${BBOX_WASH} -o format=geojson force "${PROC}/_rect.geojson"
$MS "${PROC}/_rect.geojson" \
  -erase "${PROC}/toronto-boundary.geojson" \
  -each 'kind="outside"' \
  -o format=geojson $PREC force "${PROC}/outside-mask.geojson"
rm "${PROC}/_rect.geojson"

echo "== 13. Strip null/empty-geometry features (created at write time by precision quantization) =="
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

echo "== Copy web-facing layers into public/data =="
# The app loads these from public/data (base-pathed at /toronto-micro-atlas/data).
PUB="${DATA_DIR}/../public/data"
mkdir -p "${PUB}"
for f in ravine-rnfp esa lake-ontario watercourses streets-major streets-minor \
         toronto-boundary outside-mask orientation-labels; do
  cp "${PROC}/${f}.geojson" "${PUB}/${f}.geojson"
done

echo "== Done. Outputs: =="
ls -lh "${PROC}"
