import heapq
import json
import re
from dataclasses import dataclass
from itertools import combinations

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

from fg03_schedule import Schedule, parse_weekly_hours


@dataclass(slots=True)
class Facility:
    facility_id: str
    source: str
    name: str
    address: str
    lon: float
    lat: float
    hours_raw: str
    schedule: Schedule
    accessible: bool | None
    all_gender: bool | None
    temporarily_closed: bool = False
    partial_service: bool = False
    record_count: int = 1
    source_url: str = ""
    notes: str = ""


class NetworkSnapper:
    def __init__(self, graph):
        self.nodes = list(graph.nodes)
        self.project = Transformer.from_crs(4326, 2952, always_xy=True).transform
        self.xy = np.array([self.project(node[0], node[1]) for node in self.nodes])
        self.tree = cKDTree(self.xy)

    def snap(self, lon: float, lat: float) -> tuple[tuple[float, float], float]:
        x, y = self.project(lon, lat)
        distance, index = self.tree.query([x, y])
        return self.nodes[int(index)], float(distance)


def coordinates_from_geometry(raw_geometry: str) -> tuple[float, float]:
    geometry = json.loads(raw_geometry)
    coordinates = geometry["coordinates"]
    if geometry["type"] == "MultiPoint":
        coordinates = coordinates[0]
    return float(coordinates[0]), float(coordinates[1])


def consolidate_crem_rows(rows: list[dict[str, str]]) -> list[Facility]:
    public_rows = [
        row for row in rows if row.get("Washroom Status") == "Open - Public Access"
    ]
    groups: dict[str, list[dict[str, str]]] = {}
    for row in public_rows:
        floc_id = (row.get("FLOC_ID") or "").strip()
        key = floc_id
        if not floc_id or floc_id.lower() in {"n/a", "none", "unknown"}:
            key = f"{row.get('Building Description', '')}|{row.get('Address', '')}"
        groups.setdefault(key, []).append(row)

    facilities = []
    for key, group in sorted(groups.items()):
        first = group[0]
        lon, lat = coordinates_from_geometry(first["geometry"])
        hours_values = {row.get("Hours Available", "").strip() for row in group}
        hours_raw = hours_values.pop() if len(hours_values) == 1 else ""
        facilities.append(
            Facility(
                facility_id=f"crem:{key}",
                source="crem",
                name=first.get("Building Description", "City building"),
                address=first.get("Address", ""),
                lon=lon,
                lat=lat,
                hours_raw=hours_raw,
                schedule=parse_weekly_hours(hours_raw),
                accessible=any(
                    row.get("Accessible Washroom", "").lower() == "yes"
                    for row in group
                ),
                all_gender=any(
                    row.get("Gender Inclusive", "").lower() == "yes"
                    for row in group
                ),
                record_count=len(group),
                source_url=(
                    "https://open.toronto.ca/dataset/"
                    "corporate-real-estate-management-portfolio-washrooms/"
                ),
            )
        )
    return facilities


def cluster_access_points(facilities: list[Facility]) -> dict[str, int]:
    def canonical_address(address: str) -> str:
        street_address = address.split(",", maxsplit=1)[0]
        value = re.sub(r"[^a-z0-9 ]+", " ", street_address.lower())
        replacements = {
            "street": "st",
            "road": "rd",
            "avenue": "ave",
            "boulevard": "blvd",
            "drive": "dr",
            "east": "e",
            "west": "w",
            "north": "n",
            "south": "s",
        }
        return " ".join(replacements.get(token, token) for token in value.split())

    parents = list(range(len(facilities)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    project = Transformer.from_crs(4326, 2952, always_xy=True).transform
    projected = [project(facility.lon, facility.lat) for facility in facilities]
    addresses = [canonical_address(facility.address) for facility in facilities]
    for left, right in combinations(range(len(facilities)), 2):
        if not addresses[left] or addresses[left] != addresses[right]:
            continue
        x1, y1 = projected[left]
        x2, y2 = projected[right]
        distance = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        if distance <= 100:
            union(left, right)

    cluster_numbers: dict[int, int] = {}
    result = {}
    for index, facility in enumerate(facilities):
        root = find(index)
        cluster_numbers.setdefault(root, len(cluster_numbers))
        result[facility.facility_id] = cluster_numbers[root]
    return result


def multi_source_distances(graph, source_offsets, *, cutoff: float) -> dict:
    distances = {
        node: float(offset)
        for node, offset in source_offsets.items()
        if float(offset) <= cutoff
    }
    queue = [(distance, node) for node, distance in distances.items()]
    heapq.heapify(queue)

    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        for neighbour, edge_data in graph[node].items():
            candidate = distance + float(edge_data["length"])
            if candidate > cutoff or candidate >= distances.get(neighbour, float("inf")):
                continue
            distances[neighbour] = candidate
            heapq.heappush(queue, (candidate, neighbour))
    return distances
