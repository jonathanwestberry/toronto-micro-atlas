#!/usr/bin/env bash
# Download the City of Toronto "Street Tree Data" package (WGS84 GeoJSON).
# Landing page: https://open.toronto.ca/dataset/street-tree-data/
set -euo pipefail

cd "$(dirname "$0")/../raw"

curl -sL -o street-trees-4326.geojson \
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/6ac4569e-fd37-4cbc-ac63-db3624c5f6a2/resource/d6089672-bdf7-4857-8ea8-90da826fcfa1/download/street-tree-data-4326.geojson"

ls -lh street-trees-4326.geojson
