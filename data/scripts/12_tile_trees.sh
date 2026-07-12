#!/usr/bin/env bash
# Tile the processed street tree points into a static z/x/y vector tile
# directory served by Cloudflare Pages.
#
# Only z14 tiles are generated, at full density (no feature dropping):
# below z14 the map shows the exact-count PNG renders (13_render_trees.py),
# and above z14 MapLibre overzooms these tiles. --no-tile-compression is
# required for static hosting: the host sets no Content-Encoding header,
# so tiles must be raw protobuf.
#
# Requires tippecanoe (brew install tippecanoe).
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf ../public/tiles/trees
# tippecanoe's directory output mkdirs only the last path segment; the
# parent must already exist or every tile write fails with ENOENT.
mkdir -p ../public/tiles
tippecanoe \
  -e ../public/tiles/trees \
  --layer=trees \
  --minimum-zoom=13 --maximum-zoom=14 \
  --no-feature-limit --no-tile-size-limit \
  --drop-rate=0 \
  --buffer=8 \
  --no-tile-compression \
  --force \
  processed/trees-tiling.ndjson

echo "tiles:" $(find ../public/tiles/trees -name '*.pbf' | wc -l)
echo "total size:" $(du -sh ../public/tiles/trees | cut -f1)
echo "largest:" $(find ../public/tiles/trees -name '*.pbf' -exec ls -l {} + | sort -k5 -rn | head -3 | awk '{print $5, $NF}')
