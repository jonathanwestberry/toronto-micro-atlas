#!/usr/bin/env python3
"""Download the dated official inputs for the FG03 data proof."""

import csv
import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = DATA_DIR / "raw" / "fg03"

SOURCES = {
    "park-washrooms.csv": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "394b9f09-d5d6-43dc-a7a0-660c99fc2318/resource/"
        "59489229-bb39-4218-833b-34b9de07833e/download/"
        "washroom-facilities-4326.csv"
    ),
    "libraries.csv": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "f5aa9b07-da35-45e6-b31f-d6790eb9bd9b/resource/"
        "e69b6ebb-8688-4533-8fd9-b63bff1cacdd/download/"
        "tpl-branch-general-information-4326.csv"
    ),
    "crem-washrooms.csv": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "e68ed98f-e8cd-4f43-a159-90847c4b5e48/resource/"
        "104565ec-5020-47b4-b9e5-5dc2e78a7052/download/"
        "crem-public-washrooms-4326.csv"
    ),
    "museums.csv": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "29d28f67-6b5f-4d9c-803f-eb4ae890d825/resource/"
        "2c578ad4-c534-40ec-82f1-d0c9c9ae7bad/download/"
        "museums-and-cultural-centres.csv"
    ),
    "automated-washrooms.csv": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "821fed42-92e5-4a49-8684-394c1423b78a/resource/"
        "78cab83f-3bda-47b1-a2df-cf01f3e8628f/download/"
        "public-washroom-data-4326.csv"
    ),
    "pedestrian-network.gpkg": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "4b5c7a84-dea1-4137-875d-71d7f662c83f/resource/"
        "f5390504-c209-42d5-aebe-c79a7a9267bc/download/"
        "pedestrian-network-data-4326.gpkg"
    ),
    "pedestrian-network-readme.xlsx": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "4b5c7a84-dea1-4137-875d-71d7f662c83f/resource/"
        "a84888bc-a702-4f8a-a3af-77aff25c98fd/download/"
        "pedestrian-network-readme.xlsx"
    ),
    "completegtfs.zip": (
        "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
        "b811ead4-6eaf-4adb-8408-d389fb5a069c/resource/"
        "c920e221-7a1c-488b-8c5b-6d8cd4e85eaf/download/completegtfs.zip"
    ),
}

ADDRESS_RESOURCE = "0b3756af-9caf-4f0f-ac28-9c6617adede4"
ADDRESS_API = (
    "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search"
)
CITY_FACILITY_URL = "https://www.toronto.ca/data/parks/live/locations/{}/info.json"


def request_bytes(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Toronto-Micro-Atlas-FG03-proof/1.0"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def download_sources() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for filename, url in SOURCES.items():
        destination = RAW_DIR / filename
        print(f"Downloading {filename}")
        destination.write_bytes(request_bytes(url))


def download_city_facility_hours() -> None:
    with (RAW_DIR / "park-washrooms.csv").open(
        encoding="utf-8-sig", newline=""
    ) as source:
        rows = list(csv.DictReader(source))
    location_ids = sorted(
        {
            row["id"]
            for row in rows
            if "centre" in (row.get("hours") or "").lower()
        },
        key=int,
    )

    def fetch(location_id: str) -> tuple[str, dict]:
        payload = json.loads(request_bytes(CITY_FACILITY_URL.format(location_id)))
        return location_id, payload

    with ThreadPoolExecutor(max_workers=8) as pool:
        hours = dict(pool.map(fetch, location_ids))
    (RAW_DIR / "city-facility-hours.json").write_text(
        json.dumps(hours, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(f"Downloaded {len(hours)} City facility-hour records")


def canonical_city_address(address: str) -> str:
    return address.replace(".", "").strip()


def download_museum_address_points() -> None:
    with (RAW_DIR / "museums.csv").open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    results = {}
    for row in rows:
        address = canonical_city_address(row["Address"])
        query = urllib.parse.urlencode(
            {
                "resource_id": ADDRESS_RESOURCE,
                "filters": json.dumps({"ADDRESS_FULL": address}),
                "limit": 10,
            }
        )
        response = json.loads(request_bytes(f"{ADDRESS_API}?{query}"))
        records = response["result"]["records"]
        if not records:
            raise RuntimeError(f"No City address point found for {address}")
        results[row["Museums and Cultural Centres"]] = records
    (RAW_DIR / "museum-address-points.json").write_text(
        json.dumps(results, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(f"Downloaded address points for {len(results)} museums and cultural centres")


def write_metadata() -> None:
    metadata = {
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "sources": SOURCES,
        "city_facility_hours": CITY_FACILITY_URL,
        "address_points_api": ADDRESS_API,
    }
    (RAW_DIR / "source-metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8"
    )


def main() -> None:
    download_sources()
    download_city_facility_hours()
    download_museum_address_points()
    write_metadata()
    print(f"Raw snapshot written to {RAW_DIR}")


if __name__ == "__main__":
    main()
