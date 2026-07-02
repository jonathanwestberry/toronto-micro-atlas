#!/usr/bin/env bash
# Full pipeline: download -> convert -> process.
# Usage: bash run_all.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

bash    "${HERE}/01_download_city.sh"
python3 "${HERE}/02_download_osm.py"
python3 "${HERE}/03_convert_osm.py"
bash    "${HERE}/04_process.sh"
