#!/usr/bin/env python3
"""Download OpenStreetMap layers for the Toronto map via the Overpass API.

Layers: rail lines, waterways, major streets, minor streets, and the
Lake Ontario multipolygon relation (with full member geometry).

OSM data (c) OpenStreetMap contributors, ODbL 1.0.
Usage: python3 02_download_osm.py
Note: overpass-api.de rate-limits; the script sleeps between queries and
retries once on HTTP 429. POST with form-encoded 'data' is required
(a raw query body gets a 406 from the endpoint).
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

DATA_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(DATA_DIR, "raw")
os.makedirs(RAW, exist_ok=True)

OVERPASS = "https://overpass-api.de/api/interpreter"
# Overpass bbox order: south, west, north, east.
# Extended into the GTA (was 43.57,-79.65,43.87,-79.10) so context data covers
# well beyond the eight markers and no paper void shows at the citywide floor:
# west past Mississauga, south into Lake Ontario, east to Pickering, north to
# Markham/Richmond Hill.
BBOX = "43.45,-79.85,43.98,-78.90"

QUERIES = {
    "osm-rail-raw.json":
        f'[out:json][timeout:60];(way["railway"="rail"]({BBOX}););out geom;',
    "osm-waterways-raw.json":
        f'[out:json][timeout:90];(way["waterway"~"^(river|stream|canal|drain|ditch)$"]({BBOX}););out geom;',
    "osm-streets-major-raw.json":
        f'[out:json][timeout:120];(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"]({BBOX}););out geom;',
    "osm-streets-minor-raw.json":
        f'[out:json][timeout:180];(way["highway"~"^(tertiary|tertiary_link|residential|unclassified|living_street)$"]({BBOX}););out geom;',
    # Lake Ontario is a single OSM multipolygon relation; "out geom" returns
    # every member way with coordinates so the shoreline can be rebuilt offline.
    "osm-lake-raw.json":
        f'[out:json][timeout:90];(relation["name"~"Ontario"]["natural"="water"]({BBOX}););out geom;',
}


def fetch(query: str, outfile: str, label: str, attempts: int = 3) -> None:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(OVERPASS, data=data, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Toronto-Map-Builder/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                body = resp.read()
            parsed = json.loads(body)
            with open(outfile, "wb") as f:
                f.write(body)
            print(f"{label}: {len(parsed.get('elements', []))} elements, "
                  f"{len(body) // 1024} KB")
            return
        except Exception as exc:  # noqa: BLE001
            print(f"{label}: attempt {attempt} failed ({exc})", file=sys.stderr)
            if attempt < attempts:
                time.sleep(30 * attempt)
    raise SystemExit(f"FAILED after {attempts} attempts: {label}")


def main() -> None:
    for i, (name, query) in enumerate(QUERIES.items()):
        if i:
            time.sleep(10)  # be polite to the shared Overpass instance
        fetch(query, os.path.join(RAW, name), name)


if __name__ == "__main__":
    main()
