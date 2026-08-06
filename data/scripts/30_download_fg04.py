"""Fetch every source guide four needs.

Ontario lidar tiles come out of remote packages by byte range, so the 31 GB
of packages Toronto touches never lands on disk. Toronto layers come from
CKAN as usual.

Usage: python 30_download_fg04.py
"""

import os
import subprocess
import zipfile

import geopandas as gpd

import fg04_lidar as lidar
import fg04_tiles as tiles

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, ".."))
RAW = os.path.join(DATA, "raw", "fg04")
PACKAGES = "https://ws.gisetl.lrc.gov.on.ca/fmedatadownload/Packages/"
DSM_INDEX = "https://www.publicdocs.mnr.gov.on.ca/mirb/OntarioDSM_LidarDerived_TileIndex.zip"
CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca"


def fetch(url: str, path: str) -> str:
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(["curl", "-fsSL", "--max-time", "900", "-o", path, url],
                   check=True)
    return path


def main() -> None:
    index_zip = fetch(DSM_INDEX, os.path.join(RAW, "dsm-tile-index.zip"))
    index_dir = os.path.join(RAW, "dsm-tile-index")
    if not os.path.isdir(index_dir):
        with zipfile.ZipFile(index_zip) as archive:
            archive.extractall(index_dir)

    index = gpd.read_file(index_dir)
    boundary = gpd.read_file(
        os.path.join(DATA, "..", "public", "data", "toronto-boundary.geojson"))
    wanted = tiles.tiles_for_boundary(index, boundary)
    print(f"{len(wanted)} tiles across packages {tiles.packages_needed(wanted)}")

    caches: dict[str, list] = {}
    for _, row in wanted.iterrows():
        for kind in ("DSM", "DTM"):
            package = row["Package"].replace("DSM", kind)
            name = row["FileName"] if kind == "DSM" else tiles.dtm_name(row["FileName"])
            out = os.path.join(RAW, kind.lower(), name)
            if os.path.exists(out):
                continue
            url = f"{PACKAGES}{package}.zip"
            if package not in caches:
                caches[package] = lidar.remote_entries(
                    url, cache_path=os.path.join(RAW, "cd", f"{package}.json"))
            entry = next(e for e in caches[package] if e.name == name)
            lidar.extract_entry(url, entry, out)
        print(".", end="", flush=True)
    print()

    # Resource 8b6a2d2a, not 2937a4ec. The latter is the CKAN datastore dump
    # endpoint, which serves CSV whatever filename you hang off it, and
    # geopandas cannot read it as geometry.
    fetch(f"{CKAN}/dataset/3b471f62-dc01-4a96-bb76-f794e4c6b860/resource/"
          "8b6a2d2a-d398-484f-99b5-f686f31f815d/download/"
          "neighbourhood-improvement-areas-4326.geojson",
          os.path.join(RAW, "nia-4326.geojson"))
    print("NIA downloaded.")

    # The 2018 Tree Canopy Study geodatabase does have a stable resource URL,
    # contrary to the implementation plan. 436 MB.
    fetch(f"{CKAN}/dataset/61642048-56bb-4050-b7c3-f569fcf94527/resource/"
          "69419e11-2dfa-4bcc-bed0-43a9dd2d0973/download/landcover2018_gdb.zip",
          os.path.join(RAW, "land-cover-2018.zip"))
    print("Land cover downloaded.")


if __name__ == "__main__":
    main()
