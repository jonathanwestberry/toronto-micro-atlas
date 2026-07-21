#!/usr/bin/env python3
"""Build the four-map FG03 public washroom data proof."""

import argparse
import csv
import io
import json
import math
import zipfile
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime
from itertools import combinations
from pathlib import Path

import geopandas as gpd
import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
from matplotlib.lines import Line2D
from pyproj import Transformer
from shapely.geometry import Point, shape

from fg03_proof import (
    Facility,
    NetworkSnapper,
    cluster_access_points,
    consolidate_crem_rows,
    coordinates_from_geometry,
    multi_source_distances,
)
from fg03_schedule import Availability, availability_at, parse_weekly_hours


DATA_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = DATA_DIR.parent
RAW_DIR = DATA_DIR / "raw" / "fg03"
CURATED_DIR = DATA_DIR / "fg03"
BOUNDARY_PATH = DATA_DIR / "processed" / "toronto-boundary.geojson"
WALKING_CUTOFF_METRES = 400.0
TRANSIT_WINDOW_SECONDS = 15 * 60
MAX_SNAP_METRES = 200.0

DAY_CODES = [
    ("mo", "Mon"),
    ("tu", "Tue"),
    ("w", "Wed"),
    ("th", "Thu"),
    ("f", "Fri"),
    ("sa", "Sat"),
    ("su", "Sun"),
]


@dataclass(frozen=True, slots=True)
class Snapshot:
    slug: str
    label: str
    weekday: int
    minute: int
    gtfs_seconds: int


SNAPSHOTS = [
    Snapshot("1200", "Noon", 1, 12 * 60, 12 * 60 * 60),
    Snapshot("2030", "8:30 p.m.", 1, 20 * 60 + 30, (20 * 60 + 30) * 60),
    Snapshot("2200", "10 p.m.", 1, 22 * 60, 22 * 60 * 60),
    Snapshot("0030", "12:30 a.m. next day", 2, 30, (24 * 60 + 30) * 60),
]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def city_hours_as_text(info: dict) -> str:
    hours = (info.get("hours") or [{}])[0]
    segments = []
    for code, label in DAY_CODES:
        opening = str(hours.get(f"oh{code}o") or "").strip()
        closing = str(hours.get(f"oh{code}c") or "").strip()
        if not opening or not closing or opening.lower() == "closed":
            segments.append(f"{label} Closed")
        else:
            segments.append(f"{label} {opening} to {closing}")
    return "; ".join(segments)


def load_park_facilities() -> list[Facility]:
    rows = read_csv(RAW_DIR / "park-washrooms.csv")
    city_hours = json.loads((RAW_DIR / "city-facility-hours.json").read_text())
    facilities = []
    for row in rows:
        hours_raw = (row.get("hours") or "").strip()
        if "centre" in hours_raw.lower() and row["id"] in city_hours:
            hours_raw = city_hours_as_text(city_hours[row["id"]])
        accessible_raw = (row.get("accessible") or "").strip().lower()
        accessible = None if accessible_raw in {"", "none"} else True
        lon, lat = coordinates_from_geometry(row["geometry"])
        notes = "; ".join(
            value
            for value in [row.get("Reason", ""), row.get("Comments", "")]
            if value and value != "None"
        )
        facilities.append(
            Facility(
                facility_id=f"parks:{row.get('asset_id') or row['id']}",
                source="parks",
                name=row.get("alternative_name") or row.get("location") or "Park washroom",
                address=(row.get("address") or "").strip(),
                lon=lon,
                lat=lat,
                hours_raw=hours_raw,
                schedule=parse_weekly_hours(hours_raw),
                accessible=accessible,
                all_gender=(
                    True if "all-gender" in (row.get("type") or "").lower() else None
                ),
                temporarily_closed=row.get("Status") == "0",
                partial_service=row.get("Status") == "2",
                source_url=row.get("url") or (
                    "https://open.toronto.ca/dataset/washroom-facilities/"
                ),
                notes=notes,
            )
        )
    return facilities


def load_library_facilities() -> list[Facility]:
    facilities = []
    for row in read_csv(RAW_DIR / "libraries.csv"):
        if row.get("PublicWashroom") != "1":
            continue
        lon, lat = coordinates_from_geometry(row["geometry"])
        hours_raw = row.get("Hours", "")
        facilities.append(
            Facility(
                facility_id=f"library:{row['BranchCode']}",
                source="library",
                name=f"{row['BranchName']} library",
                address=row.get("Address", ""),
                lon=lon,
                lat=lat,
                hours_raw=hours_raw,
                schedule=parse_weekly_hours(hours_raw),
                accessible=None,
                all_gender=None,
                source_url=row.get("Website", ""),
            )
        )
    return facilities


def load_museum_facilities() -> list[Facility]:
    address_points = json.loads((RAW_DIR / "museum-address-points.json").read_text())
    facilities = []
    for index, row in enumerate(read_csv(RAW_DIR / "museums.csv"), start=1):
        if row.get("Washroom?") != "Yes":
            continue
        name = row["Museums and Cultural Centres"]
        geometry = json.loads(address_points[name][0]["geometry"])
        lon, lat = geometry["coordinates"]
        hours_raw = row.get("Hours", "")
        accessible_raw = row.get("Accessible?", "").lower()
        facilities.append(
            Facility(
                facility_id=f"museum:{index}",
                source="museum",
                name=name,
                address=row.get("Address", ""),
                lon=float(lon),
                lat=float(lat),
                hours_raw=hours_raw,
                schedule=parse_weekly_hours(hours_raw),
                accessible=(
                    True
                    if accessible_raw == "yes"
                    else False if accessible_raw == "no" else None
                ),
                all_gender=(
                    True
                    if row.get("Gender Inclusive?", "").lower() == "yes"
                    else False
                ),
                source_url=(
                    "https://open.toronto.ca/dataset/museums-and-cultural-centres/"
                ),
                notes=row.get("Notes", ""),
            )
        )
    return facilities


def load_automated_facilities() -> list[Facility]:
    facilities = []
    for row in read_csv(RAW_DIR / "automated-washrooms.csv"):
        lon, lat = coordinates_from_geometry(row["geometry"])
        address = " ".join(
            part
            for part in [row.get("ADDRESSNUMBERTEXT", ""), row.get("ADDRESSSTREET", "")]
            if part
        )
        hours_raw = "Seasonal Apr-Oct; daily hours not published"
        facilities.append(
            Facility(
                facility_id=f"automated:{row['ID']}",
                source="automated",
                name=f"Automated public washroom at {address}",
                address=address,
                lon=lon,
                lat=lat,
                hours_raw=hours_raw,
                schedule=None,
                accessible=True,
                all_gender=None,
                temporarily_closed=row.get("STATUS") != "Existing",
                source_url=(
                    "https://open.toronto.ca/dataset/"
                    "street-furniture-public-washroom/"
                ),
                notes="Barrier-free and seasonal. Exact daily hours are not published.",
            )
        )
    return facilities


def read_gtfs_table(archive: zipfile.ZipFile, filename: str) -> list[dict[str, str]]:
    with archive.open(filename) as raw:
        return list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig")))


def load_ttc_facilities(gtfs_path: Path) -> list[Facility]:
    rows = read_csv(CURATED_DIR / "ttc-washroom-stations.csv")
    with zipfile.ZipFile(gtfs_path) as archive:
        stops = read_gtfs_table(archive, "stops.txt")
    stations = {
        row["stop_name"]: row
        for row in stops
        if row.get("location_type") == "1"
    }
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["station"]].append(row)

    hours_raw = "Mon-Sat 6 a.m. to 2 a.m.; Sun 8 a.m. to 2 a.m."
    facilities = []
    for station_name, group in sorted(grouped.items()):
        if station_name not in stations:
            raise RuntimeError(f"TTC washroom station missing from GTFS: {station_name}")
        station = stations[station_name]
        facilities.append(
            Facility(
                facility_id=f"ttc:{station_name.lower().replace(' ', '-')} ".strip(),
                source="ttc",
                name=f"{station_name} station",
                address=station_name,
                lon=float(station["stop_lon"]),
                lat=float(station["stop_lat"]),
                hours_raw=hours_raw,
                schedule=parse_weekly_hours(hours_raw),
                accessible=True,
                all_gender=None,
                record_count=len(group),
                source_url=group[0]["source_url"],
                notes="Located in the fare-paid area.",
            )
        )
    return facilities


def load_facilities(gtfs_path: Path, boundary) -> tuple[list[Facility], list[Facility]]:
    facilities = []
    facilities.extend(load_park_facilities())
    facilities.extend(load_library_facilities())
    facilities.extend(consolidate_crem_rows(read_csv(RAW_DIR / "crem-washrooms.csv")))
    facilities.extend(load_museum_facilities())
    facilities.extend(load_automated_facilities())
    facilities.extend(load_ttc_facilities(gtfs_path))
    inside = [f for f in facilities if boundary.covers(Point(f.lon, f.lat))]
    outside = [f for f in facilities if not boundary.covers(Point(f.lon, f.lat))]
    return inside, outside


def active_service_ids(
    archive: zipfile.ZipFile, service_date: date
) -> set[str]:
    calendar = read_gtfs_table(archive, "calendar.txt")
    day_name = service_date.strftime("%A").lower()
    ymd = service_date.strftime("%Y%m%d")
    active = {
        row["service_id"]
        for row in calendar
        if row[day_name] == "1" and row["start_date"] <= ymd <= row["end_date"]
    }
    for row in read_gtfs_table(archive, "calendar_dates.txt"):
        if row["date"] != ymd:
            continue
        if row["exception_type"] == "1":
            active.add(row["service_id"])
        elif row["exception_type"] == "2":
            active.discard(row["service_id"])
    return active


def gtfs_seconds(raw_time: str) -> int:
    hours, minutes, seconds = (int(value) for value in raw_time.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def load_active_transit_stops(
    gtfs_path: Path, service_date: date, boundary
) -> dict[str, list[dict[str, float | str]]]:
    by_snapshot = {snapshot.slug: set() for snapshot in SNAPSHOTS}
    with zipfile.ZipFile(gtfs_path) as archive:
        active_services = active_service_ids(archive, service_date)
        trips = read_gtfs_table(archive, "trips.txt")
        active_trips = {
            row["trip_id"] for row in trips if row["service_id"] in active_services
        }

        with archive.open("stop_times.txt") as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"))
            for row in reader:
                if row["trip_id"] not in active_trips:
                    continue
                raw_time = row.get("departure_time") or row.get("arrival_time")
                if not raw_time:
                    continue
                seconds = gtfs_seconds(raw_time)
                for snapshot in SNAPSHOTS:
                    if abs(seconds - snapshot.gtfs_seconds) <= TRANSIT_WINDOW_SECONDS:
                        by_snapshot[snapshot.slug].add(row["stop_id"])

        stops = read_gtfs_table(archive, "stops.txt")
    stop_lookup = {row["stop_id"]: row for row in stops}

    result = {}
    for slug, stop_ids in by_snapshot.items():
        collapsed = {}
        for stop_id in stop_ids:
            stop = stop_lookup.get(stop_id)
            if not stop:
                continue
            key = stop.get("parent_station") or stop_id
            point_row = stop_lookup.get(key, stop)
            lon = float(point_row["stop_lon"])
            lat = float(point_row["stop_lat"])
            if not boundary.covers(Point(lon, lat)):
                continue
            collapsed[key] = {
                "stop_id": key,
                "name": point_row["stop_name"],
                "lon": lon,
                "lat": lat,
            }
        result[slug] = list(collapsed.values())
    return result


def build_pedestrian_graph() -> tuple[nx.Graph, gpd.GeoDataFrame]:
    edges = gpd.read_file(RAW_DIR / "pedestrian-network.gpkg").explode(
        index_parts=False, ignore_index=True
    )
    graph = nx.Graph()
    edge_nodes = []
    for row in edges.itertuples():
        coordinates = list(row.geometry.coords)
        start = tuple(round(value, 7) for value in coordinates[0][:2])
        end = tuple(round(value, 7) for value in coordinates[-1][:2])
        length = float(row.LENGTH)
        graph.add_node(start, lon=start[0], lat=start[1])
        graph.add_node(end, lon=end[0], lat=end[1])
        if graph.has_edge(start, end):
            graph[start][end]["length"] = min(
                length, float(graph[start][end]["length"])
            )
        else:
            graph.add_edge(start, end, length=length)
        edge_nodes.append((start, end))
    edges["_u"] = [nodes[0] for nodes in edge_nodes]
    edges["_v"] = [nodes[1] for nodes in edge_nodes]
    return graph, edges


def facility_state(facility: Facility, snapshot: Snapshot) -> Availability:
    return availability_at(
        facility.schedule,
        weekday=snapshot.weekday,
        minute=snapshot.minute,
        temporarily_closed=facility.temporarily_closed,
    )


def source_offsets_for_open_facilities(
    facilities: list[Facility],
    states: dict[str, Availability],
    facility_snaps: dict[str, tuple[tuple[float, float], float]],
) -> dict[tuple[float, float], float]:
    offsets = {}
    for facility in facilities:
        if states[facility.facility_id] != Availability.OPEN:
            continue
        node, offset = facility_snaps[facility.facility_id]
        if offset > MAX_SNAP_METRES:
            continue
        offsets[node] = min(offset, offsets.get(node, float("inf")))
    return offsets


def plot_snapshot(
    output_path: Path,
    snapshot: Snapshot,
    boundary_gdf: gpd.GeoDataFrame,
    edges: gpd.GeoDataFrame,
    reached_edges: gpd.GeoDataFrame,
    open_facilities: list[Facility],
    active_stops: list[dict[str, float | str]],
    summary: dict,
) -> None:
    fig, axis = plt.subplots(figsize=(9, 9), facecolor="#f3efe6")
    axis.set_facecolor("#f3efe6")
    boundary_gdf.plot(ax=axis, color="#eee8dc", edgecolor="#8a857c", linewidth=0.55)
    edges.plot(ax=axis, color="#d2cdc3", linewidth=0.08, alpha=0.58)
    if len(active_stops):
        axis.scatter(
            [stop["lon"] for stop in active_stops],
            [stop["lat"] for stop in active_stops],
            s=1.5,
            color="#1d6380",
            alpha=0.45,
            linewidths=0,
            zorder=3,
        )
    if len(reached_edges):
        reached_edges.plot(ax=axis, color="#d6573d", linewidth=0.42, alpha=0.9)
    axis.scatter(
        [facility.lon for facility in open_facilities],
        [facility.lat for facility in open_facilities],
        s=5.5,
        color="#151515",
        linewidths=0,
        zorder=5,
    )
    axis.set_title(
        f"{snapshot.label}\n"
        f"{summary['open_access_points']} open access points  |  "
        f"{summary['covered_transit_stops']:,} of "
        f"{summary['active_transit_stops']:,} active TTC stops covered",
        loc="left",
        fontsize=13,
        fontweight="bold",
        pad=10,
    )
    axis.text(
        0,
        -0.025,
        "Tuesday, July 21, 2026 schedule. After-midnight transit uses Tuesday's service day. "
        "Coverage is 400 m along the City pedestrian network.",
        transform=axis.transAxes,
        fontsize=7.5,
        color="#55514a",
        va="top",
    )
    legend = [
        Line2D([0], [0], color="#d6573d", lw=2, label="Washroom-reachable network"),
        Line2D(
            [0],
            [0],
            marker="o",
            color="none",
            markerfacecolor="#1d6380",
            markeredgecolor="none",
            markersize=5,
            label="Scheduled TTC stop activity",
        ),
        Line2D(
            [0],
            [0],
            marker="o",
            color="none",
            markerfacecolor="#151515",
            markeredgecolor="none",
            markersize=5,
            label="Documented open washroom",
        ),
    ]
    axis.legend(handles=legend, loc="lower left", frameon=False, fontsize=8)
    axis.set_xlim(-79.66, -79.09)
    axis.set_ylim(43.57, 43.88)
    axis.set_aspect("equal")
    axis.axis("off")
    fig.tight_layout(pad=1.1)
    fig.savefig(output_path, dpi=180, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)


def write_contact_sheet(output_dir: Path) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(14, 14), facecolor="#f3efe6")
    for axis, snapshot in zip(axes.flat, SNAPSHOTS):
        image = plt.imread(output_dir / f"coverage-{snapshot.slug}.png")
        axis.imshow(image)
        axis.axis("off")
    fig.suptitle(
        "When Toronto Has to Go: four time snapshots",
        fontsize=18,
        fontweight="bold",
        x=0.04,
        ha="left",
    )
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(
        output_dir / "coverage-contact-sheet.png",
        dpi=160,
        facecolor=fig.get_facecolor(),
        bbox_inches="tight",
    )
    plt.close(fig)


def nearby_cross_source_pairs(facilities: list[Facility]) -> list[dict]:
    project = Transformer.from_crs(4326, 2952, always_xy=True).transform
    points = [project(facility.lon, facility.lat) for facility in facilities]
    pairs = []
    for left, right in combinations(range(len(facilities)), 2):
        first = facilities[left]
        second = facilities[right]
        if first.source == second.source:
            continue
        distance = math.dist(points[left], points[right])
        if distance > 50:
            continue
        pairs.append(
            {
                "distance_m": round(distance, 1),
                "source_a": first.source,
                "name_a": first.name,
                "address_a": first.address,
                "source_b": second.source,
                "name_b": second.name,
                "address_b": second.address,
            }
        )
    return sorted(pairs, key=lambda row: row["distance_m"])


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", encoding="utf-8", newline="") as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def write_readme(
    output_dir: Path,
    snapshot_date: date,
    facilities: list[Facility],
    outside: list[Facility],
    summaries: list[dict],
    nearby_pairs: list[dict],
) -> None:
    by_slug = {summary["slug"]: summary for summary in summaries}
    noon = by_slug["1200"]
    late = by_slug["2200"]
    overnight = by_slug["0030"]
    open_drop = 100 * (1 - late["open_access_points"] / noon["open_access_points"])
    lines = [
        "# Field Guide 03 data proof",
        "",
        f"Snapshot date: {snapshot_date.isoformat()} (Tuesday service day)",
        "",
        "## Result",
        "",
        (
            f"Documented open access points fall from {noon['open_access_points']} at noon "
            f"to {late['open_access_points']} at 10 p.m., a {open_drop:.1f}% contraction. "
            f"At 12:30 a.m., {overnight['active_transit_stops']:,} TTC stops still show "
            f"scheduled activity within the 30-minute observation window, while only "
            f"{overnight['open_access_points']} washroom access points remain reliably open."
        ),
        "",
        "This passes the temporal-pattern part of the proof. It does not yet rank priority "
        "areas or test 300 m and 500 m sensitivity. Those remain Phase 2 work before the "
        "full product build is committed.",
        "",
        "## Snapshot summary",
        "",
        "| Time | Open access points | Open facility records | Unknown hours | Active TTC stops | TTC stops covered |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for summary in summaries:
        lines.append(
            f"| {summary['label']} | {summary['open_access_points']} | "
            f"{summary['open_facility_records']} | {summary['unknown_hours']} | "
            f"{summary['active_transit_stops']:,} | {summary['covered_transit_stops']:,} "
            f"({summary['transit_coverage_pct']:.1f}%) |"
        )
    lines.extend(
        [
            "",
            "## Facility audit",
            "",
            f"- {len(facilities)} in-boundary facility locations after source-specific consolidation.",
            f"- {sum(f.record_count for f in facilities)} underlying source records.",
            f"- {len(outside)} facility locations excluded outside the Toronto boundary.",
            f"- {len(nearby_pairs)} cross-source pairs within 50 m are listed in `nearby-cross-source-pairs.csv`.",
            "- Manual decisions for those pairs are recorded in `data/fg03/nearby-pair-audit.csv`.",
            "- Same-address records within 100 m share one access-point cluster. Distinct addresses remain separate even when nearby.",
            "- Automated public washrooms remain information gaps because the official source publishes the season but not daily hours.",
            "- Library accessibility remains unknown because the source confirms public washrooms but does not publish washroom-level accessibility.",
            "",
            "## Method",
            "",
            "1. Consolidate Parks, libraries, CREM buildings, museums and cultural centres, automated public washrooms, and TTC washroom stations.",
            "2. Normalize published weekly hours. Keep unknown hours distinct from scheduled closure.",
            "3. Apply live Parks closure status. Partial closures remain available with a flag.",
            "4. Snap open facilities and scheduled TTC stops to the City Pedestrian Network.",
            "5. Run a multi-source 400 m shortest-path search with the facility-to-network snap offset included.",
            "6. Count a TTC stop as covered only when its network distance plus stop snap distance is at most 400 m.",
            "",
            "The City describes the pedestrian network as topologically focused and notes known completeness and classification limitations. These maps show documented scheduled access, not guaranteed real-time availability or passenger demand.",
        ]
    )
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(snapshot_date: date) -> Path:
    output_dir = DATA_DIR / "proof" / "fg03" / snapshot_date.isoformat()
    output_dir.mkdir(parents=True, exist_ok=True)

    boundary_data = json.loads(BOUNDARY_PATH.read_text())
    boundary = shape(boundary_data["features"][0]["geometry"])
    boundary_gdf = gpd.GeoDataFrame(
        [{"geometry": boundary}], geometry="geometry", crs="EPSG:4326"
    )
    gtfs_path = RAW_DIR / "completegtfs.zip"
    facilities, outside = load_facilities(gtfs_path, boundary)
    clusters = cluster_access_points(facilities)

    print(f"Facilities inside Toronto: {len(facilities)}")
    print(f"Facilities outside Toronto: {len(outside)}")
    print("Building pedestrian graph")
    graph, edges = build_pedestrian_graph()
    snapper = NetworkSnapper(graph)
    facility_snaps = {
        facility.facility_id: snapper.snap(facility.lon, facility.lat)
        for facility in facilities
    }
    snap_distances = [distance for _node, distance in facility_snaps.values()]
    if max(snap_distances) > MAX_SNAP_METRES:
        print(
            f"Warning: {sum(d > MAX_SNAP_METRES for d in snap_distances)} facilities "
            f"snap farther than {MAX_SNAP_METRES:.0f} m"
        )

    print("Reading active TTC stop times")
    active_stops = load_active_transit_stops(gtfs_path, snapshot_date, boundary)
    summaries = []
    facility_state_rows = []
    for snapshot in SNAPSHOTS:
        print(f"Building snapshot {snapshot.label}")
        states = {
            facility.facility_id: facility_state(facility, snapshot)
            for facility in facilities
        }
        offsets = source_offsets_for_open_facilities(
            facilities, states, facility_snaps
        )
        distances = multi_source_distances(
            graph, offsets, cutoff=WALKING_CUTOFF_METRES
        )
        reached_mask = [
            start in distances and end in distances
            for start, end in zip(edges["_u"], edges["_v"])
        ]
        reached_edges = edges[reached_mask]
        open_facilities = [
            facility
            for facility in facilities
            if states[facility.facility_id] == Availability.OPEN
            and facility_snaps[facility.facility_id][1] <= MAX_SNAP_METRES
        ]
        open_clusters = {
            clusters[facility.facility_id] for facility in open_facilities
        }

        transit_rows = active_stops[snapshot.slug]
        covered_transit = 0
        for stop in transit_rows:
            node, snap_distance = snapper.snap(float(stop["lon"]), float(stop["lat"]))
            if distances.get(node, float("inf")) + snap_distance <= WALKING_CUTOFF_METRES:
                covered_transit += 1

        state_counts = Counter(states.values())
        open_by_source = Counter(facility.source for facility in open_facilities)
        unknown_by_source = Counter(
            facility.source
            for facility in facilities
            if states[facility.facility_id] == Availability.UNKNOWN
        )
        summary = {
            "slug": snapshot.slug,
            "label": snapshot.label,
            "open_access_points": len(open_clusters),
            "open_facility_records": len(open_facilities),
            "scheduled_closed": state_counts[Availability.CLOSED],
            "temporarily_closed": state_counts[Availability.TEMPORARILY_CLOSED],
            "unknown_hours": state_counts[Availability.UNKNOWN],
            "confirmed_accessible_open": sum(
                facility.accessible is True for facility in open_facilities
            ),
            "active_transit_stops": len(transit_rows),
            "covered_transit_stops": covered_transit,
            "transit_coverage_pct": (
                100 * covered_transit / len(transit_rows) if transit_rows else 0
            ),
            "open_by_source": dict(sorted(open_by_source.items())),
            "unknown_by_source": dict(sorted(unknown_by_source.items())),
        }
        summaries.append(summary)
        plot_snapshot(
            output_dir / f"coverage-{snapshot.slug}.png",
            snapshot,
            boundary_gdf,
            edges,
            reached_edges,
            open_facilities,
            transit_rows,
            summary,
        )
        for facility in facilities:
            facility_state_rows.append(
                {
                    "facility_id": facility.facility_id,
                    "snapshot": snapshot.slug,
                    "state": states[facility.facility_id].value,
                }
            )

    write_contact_sheet(output_dir)
    nearby_pairs = nearby_cross_source_pairs(facilities)

    facility_rows = []
    for facility in facilities:
        row = asdict(facility)
        row["schedule"] = "parsed" if facility.schedule is not None else "unknown"
        row["cluster_id"] = clusters[facility.facility_id]
        row["snap_distance_m"] = round(
            facility_snaps[facility.facility_id][1], 1
        )
        facility_rows.append(row)
    write_csv(output_dir / "facilities.csv", facility_rows)
    write_csv(output_dir / "facility-states.csv", facility_state_rows)
    write_csv(output_dir / "nearby-cross-source-pairs.csv", nearby_pairs)
    flat_summaries = [
        {
            key: value
            for key, value in summary.items()
            if key not in {"open_by_source", "unknown_by_source"}
        }
        for summary in summaries
    ]
    write_csv(output_dir / "snapshot-summary.csv", flat_summaries)
    (output_dir / "summary.json").write_text(
        json.dumps(
            {
                "generated_at": datetime.now().astimezone().isoformat(),
                "snapshot_date": snapshot_date.isoformat(),
                "walking_cutoff_metres": WALKING_CUTOFF_METRES,
                "transit_window_minutes": TRANSIT_WINDOW_SECONDS // 60,
                "facility_count_inside": len(facilities),
                "underlying_source_records": sum(
                    facility.record_count for facility in facilities
                ),
                "facility_count_outside": len(outside),
                "outside_facilities": [asdict(facility) for facility in outside],
                "network_nodes": graph.number_of_nodes(),
                "network_edges": graph.number_of_edges(),
                "facility_snap_max_m": max(snap_distances),
                "facility_snap_median_m": float(np.median(snap_distances)),
                "snap_over_200m": sum(
                    distance > MAX_SNAP_METRES for distance in snap_distances
                ),
                "snapshots": summaries,
            },
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )
    write_readme(
        output_dir,
        snapshot_date,
        facilities,
        outside,
        summaries,
        nearby_pairs,
    )
    print(f"Proof written to {output_dir}")
    return output_dir


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--snapshot-date",
        type=date.fromisoformat,
        default=date(2026, 7, 21),
        help="Tuesday service date in YYYY-MM-DD format",
    )
    arguments = parser.parse_args()
    build(arguments.snapshot_date)


if __name__ == "__main__":
    main()
