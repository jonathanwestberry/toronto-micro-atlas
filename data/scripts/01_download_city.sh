#!/usr/bin/env bash
# Download City of Toronto Open Data layers (CKAN portal).
# Datasets: Ravine & Natural Feature Protection area, Green Spaces, Parks,
#           Environmentally Significant Areas.
# License: Open Government Licence - Toronto.
# Usage: bash 01_download_city.sh
set -euo pipefail

DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RAW="${DATA_DIR}/raw"
mkdir -p "${RAW}"

CKAN="https://ckan0.cf.opendata.inter.prod-toronto.ca"

echo "== RNFP (Ravine & Natural Feature Protection area, SHP) =="
curl -fsSL -o "${RAW}/rnfp-wgs84.zip" \
  "${CKAN}/dataset/204a7e54-8963-4e35-992e-5f21544ef595/resource/bb81bb0f-f88a-4f3e-bca7-a328154ba31b/download/ravine-natural-feature-protection-area-wgs84.zip"
mkdir -p "${RAW}/rnfp-shp"
unzip -oq "${RAW}/rnfp-wgs84.zip" -d "${RAW}/rnfp-shp"

echo "== Green Spaces (GeoJSON, EPSG:4326) =="
curl -fsSL -o "${RAW}/green-spaces-4326.geojson" \
  "${CKAN}/dataset/9a284a84-b9ff-484b-9e30-82f22c1780b9/resource/7a26629c-b642-4093-b33c-a5a21e4f3d22/download/green-spaces-4326.geojson"

echo "== Parks (SHP, WGS84) =="
curl -fsSL -o "${RAW}/parks-wgs84.zip" \
  "${CKAN}/dataset/2aac8903-23ff-4072-ab72-b76cac44ad89/resource/9f53c253-a47e-497f-8a07-528f7d7aad90/download/parks-wgs84.zip"
mkdir -p "${RAW}/parks-shp"
unzip -oq "${RAW}/parks-wgs84.zip" -d "${RAW}/parks-shp"

echo "== Environmentally Significant Areas (GeoJSON, EPSG:4326) =="
curl -fsSL -o "${RAW}/esa-4326.geojson" \
  "${CKAN}/dataset/ef5a083a-5c2a-4207-9131-dfc917917069/resource/a72afc3e-881b-48f7-9a42-0b1fe55fdf4a/download/environmentally-significant-areas-4326.geojson"

echo "== Regional Municipal Boundary (SHP, WGS84) =="
curl -fsSL -o "${RAW}/toronto-boundary-wgs84.zip" \
  "${CKAN}/dataset/841fb820-46d0-46ac-8dcb-d20f27e57bcc/resource/41bf97f0-da1a-46a9-ac25-5ce0078d6760/download/toronto-boundary-wgs84.zip"
mkdir -p "${RAW}/boundary-shp"
unzip -oq "${RAW}/toronto-boundary-wgs84.zip" -d "${RAW}/boundary-shp"

echo "== Repairing City shapefiles =="
# The RNFP .shp as published has a corrupt header (file-length field says 100
# bytes) and both City .prj files use non-standard WKT that mapshaper cannot
# parse. Fix both here so the rest of the pipeline is clean.
export RAW_DIR="${RAW}"
python3 - <<'PYEOF'
import os, struct, shutil

raw = os.environ["RAW_DIR"]

# --- Fix RNFP .shp header length field ---
src = os.path.join(raw, "rnfp-shp", "RAVINE_BYLAW_WGS84.shp")
dst = os.path.join(raw, "rnfp-shp", "RAVINE_BYLAW_WGS84_fixed.shp")
with open(src, "rb") as f:
    data = bytearray(f.read())
data[24:28] = struct.pack(">i", len(data) // 2)  # length in 16-bit words
with open(dst, "wb") as f:
    f.write(data)
for ext in (".dbf", ".shx"):
    shutil.copy2(src[:-4] + ext, dst[:-4] + ext)

# --- Replace malformed .prj files with standard EPSG:4326 WKT ---
WGS84 = ('GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,'
         '298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",'
         '0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]')
for prj in (os.path.join(raw, "rnfp-shp", "RAVINE_BYLAW_WGS84_fixed.prj"),
            os.path.join(raw, "parks-shp", "CITY_GREEN_SPACE_WGS84.prj"),
            os.path.join(raw, "boundary-shp", "citygcs_regional_mun_wgs84.prj")):
    with open(prj, "w") as f:
        f.write(WGS84)

print("RNFP header fixed; .prj files normalized to EPSG:4326")
PYEOF
