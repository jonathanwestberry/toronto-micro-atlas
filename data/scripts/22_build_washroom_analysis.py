#!/usr/bin/env python3
"""Build the dated FG03 Phase 2 analytical and browser contracts."""

import argparse
import csv
import gzip
import hashlib
import heapq
import json
import math
import os
import re
import resource
import shutil
import tempfile
import time
from collections import Counter, defaultdict
from dataclasses import asdict, replace
from datetime import date, datetime
from pathlib import Path
from typing import Iterable

import geopandas as gpd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import networkx as nx
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, Point, shape
from shapely.ops import substring

from fg03_analysis import (
    CandidateGain,
    FacilityEvidence,
    FacilitySnapshot,
    NearestFacility,
    Scenario,
    candidate_public_projection,
    classify_gap,
    effective_facility_state,
    eligible_facilities,
    evaluate_product_gate,
)
from fg03_interventions import (
    CoverageFootprint,
    NewFacilitySeed,
    ScenarioInputs,
    SnapshotEvents,
    SnapshotStops,
    simulate_accessibility_retrofits,
    simulate_hours_extensions,
    simulate_information_verification,
    simulate_new_facility_zones,
)
from fg03_network import (
    NetworkLengthOverride,
    NetworkTopologyException,
    NetworkValidationError,
    batch_snap_points,
    build_network,
)
from fg03_schedule import Availability, availability_at, parse_weekly_hours
from fg03_transit import ActiveStopEvent, active_stop_events_for_windows


SNAPSHOTS = {
    "1200": (1, 12 * 60, 12 * 60),
    "2030": (1, 20 * 60 + 30, 20 * 60 + 30),
    "2200": (1, 22 * 60, 22 * 60),
    "0030": (2, 30, 24 * 60 + 30),
}
SATURDAY_SNAPSHOTS = {
    "sat-2200": (5, 22 * 60, 22 * 60),
    "sat-0030": (6, 30, 24 * 60 + 30),
}
WALKS = (300, 400, 500)
ACCESS_MODES = ("public", "rider_conditional")
PUBLIC_ACTIONS = ("open", "extend", "new", "verify", "retrofit")
PUBLIC_ACTION_BY_CLASS = {
    "extend_hours": "extend",
    "new_facility_zone": "new",
    "verify_information": "verify",
    "retrofit_accessibility": "retrofit",
}
MAX_SNAP_METRES = 200.0
MAX_STOP_SNAP_METRES = 500.0
PUBLIC_SIZE_LIMIT = 1_500_000
ANALYSIS_FINGERPRINT_VERSION = 3
PUBLIC_PLACE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
PUBLIC_ID_NAMESPACE_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"
)
PUBLIC_FILENAMES = (
    "manifest.json",
    "facilities.geojson",
    "interventions.geojson",
    "reach-facilities.geojson",
    "reach-promoted.geojson",
    "stops-1200.geojson",
    "stops-2030.geojson",
    "stops-2200.geojson",
    "stops-0030.geojson",
)


class Phase2BuildError(RuntimeError):
    """A coded, actionable Phase 2 build failure."""


def _fail(code: str, detail: str) -> Phase2BuildError:
    return Phase2BuildError(f"{code}: {detail}")


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def _bool(value: str | bool | None) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes"}


def _accessibility(value: str) -> str:
    raw = value.strip().lower()
    if raw in {"true", "yes", "1", "accessible"}:
        return "accessible"
    if raw in {"false", "no", "0", "inaccessible"}:
        return "inaccessible"
    return "unknown"


def _json_bytes(value) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _analysis_fingerprint(
    *,
    snapshot_date: str,
    candidate_projections: Iterable[dict],
    audit_contexts: Iterable[dict],
    source_paths: dict[str, Path],
) -> str:
    payload = {
        "schemaVersion": ANALYSIS_FINGERPRINT_VERSION,
        "snapshotDate": snapshot_date,
        "inputs": {
            name: _file_sha256(path)
            for name, path in sorted(source_paths.items())
        },
        "candidates": sorted(
            candidate_projections,
            key=lambda item: item["candidate_id"],
        ),
        "auditContext": sorted(
            audit_contexts,
            key=lambda item: item["candidateId"],
        ),
    }
    return hashlib.sha256(_json_bytes(payload)).hexdigest()


def _public_place_id(internal_id: str) -> str:
    if PUBLIC_PLACE_ID_PATTERN.fullmatch(internal_id):
        return internal_id
    namespace, separator, _tail = internal_id.partition(":")
    if not separator or not PUBLIC_ID_NAMESPACE_PATTERN.fullmatch(namespace):
        namespace = "place"
    digest = hashlib.sha256(internal_id.encode("utf-8")).hexdigest()
    return f"{namespace}:{digest}"


def _public_place_id_map(internal_ids: Iterable[str]) -> dict[str, str]:
    mapping = {}
    internal_by_public = {}
    for internal_id in sorted(set(internal_ids)):
        public_id = _public_place_id(internal_id)
        previous = internal_by_public.get(public_id)
        if previous is not None and previous != internal_id:
            raise _fail(
                "FG03_PUBLIC_ID_COLLISION",
                f"internal IDs {previous!r} and {internal_id!r} publish as {public_id!r}",
            )
        mapping[internal_id] = public_id
        internal_by_public[public_id] = internal_id
    return mapping


def _public_reach_id(public_place_id: str, walk: int) -> str:
    readable_id = f"reach:{public_place_id}:{walk}"
    if PUBLIC_PLACE_ID_PATTERN.fullmatch(readable_id):
        return readable_id
    digest = hashlib.sha256(public_place_id.encode("utf-8")).hexdigest()
    return f"reach:{digest}:{walk}"


def _write_json(path: Path, value) -> None:
    path.write_bytes(_json_bytes(value))


def _write_csv(path: Path, rows: Iterable[dict], fieldnames: Iterable[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(
            target,
            fieldnames=tuple(fieldnames),
            extrasaction="ignore",
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)


def _feature_collection(features: Iterable[dict]) -> dict:
    return {
        "type": "FeatureCollection",
        "schemaVersion": 1,
        "features": list(features),
    }


def _multi_source_distances(
    graph: nx.Graph,
    sources: dict[tuple[float, float], float],
    *,
    cutoff: float,
) -> dict[tuple[float, float], float]:
    distances = dict(sources)
    queue = [(distance, node) for node, distance in sources.items()]
    heapq.heapify(queue)
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node) or distance > cutoff:
            continue
        for neighbor, edge in graph[node].items():
            candidate = distance + float(edge["length"])
            if candidate <= cutoff and candidate < distances.get(neighbor, math.inf):
                distances[neighbor] = candidate
                heapq.heappush(queue, (candidate, neighbor))
    return distances


def _atomic_publish(staging: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = destination.parent / f".{destination.name}.backup-{os.getpid()}"
    if backup.exists():
        shutil.rmtree(backup)
    if destination.exists():
        destination.rename(backup)
    try:
        staging.rename(destination)
    except Exception:
        if backup.exists():
            backup.rename(destination)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def _network_exceptions(path: Path):
    topology = []
    lengths = []
    for row in _read_csv(path):
        record_type = row.get("record_type", "intersection")
        first = row.get("first_objectid") or row.get("objectid_a")
        second = row.get("second_objectid") or row.get("objectid_b")
        x = row.get("x") or row.get("x_2952")
        y = row.get("y") or row.get("y_2952")
        action = row.get("action", "")
        if record_type in {"topology", "intersection"}:
            if action == "connect_at_source_vertex":
                continue
            topology.append(
                NetworkTopologyException(
                    first_objectid=int(first),
                    second_objectid=int(second),
                    x=float(x),
                    y=float(y),
                    action=(
                        "connect"
                        if action == "connect_at_intersection"
                        else action
                    ),
                    reason=row.get("reason") or row.get("evidence_note", ""),
                )
            )
        elif record_type in {"length_override", "length"}:
            lengths.append(
                NetworkLengthOverride(
                    objectid=int(first),
                    action=action,
                    reason=row.get("reason") or row.get("evidence_note", ""),
                )
            )
        else:
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"unknown network exception record_type {record_type!r} in {path}",
            )
    return tuple(topology), tuple(lengths)


def _validate_snap_offsets(snaps) -> None:
    for entity_id, snap in snaps.items():
        limit = (
            MAX_STOP_SNAP_METRES
            if entity_id.startswith("stop:")
            else MAX_SNAP_METRES
        )
        if snap.offset_metres > limit:
            raise _fail(
                "FG03_SNAP_TOO_FAR",
                f"{entity_id} snapped {snap.offset_metres:.1f} metres, above {limit:.0f}; inspect source coordinates and network coverage",
            )


def _load_facilities(proof_dir: Path):
    rows = _read_csv(proof_dir / "facilities.csv")
    facilities = []
    raw_by_id = {}
    schedules = {}
    for row in rows:
        facility_id = row["facility_id"]
        evidence = FacilityEvidence(
            facility_id=facility_id,
            name=row["name"],
            source=row["source"],
            address=row.get("address", ""),
            lon=float(row["lon"]),
            lat=float(row["lat"]),
            hours=row.get("hours_raw", ""),
            access_condition=row["access_condition"],
            closure_category=row["closure_category"],
            accessibility=_accessibility(row.get("accessible", "")),
            partial_service=_bool(row.get("partial_service")),
            source_url=row.get("source_url", ""),
            notes=row.get("notes", ""),
        )
        facilities.append(evidence)
        raw_by_id[facility_id] = row
        schedules[facility_id] = parse_weekly_hours(row.get("hours_raw", ""))
    if len({item.facility_id for item in facilities}) != len(facilities):
        raise _fail(
            "FG03_CONTRACT_INVALID",
            f"facility IDs are not unique in {proof_dir / 'facilities.csv'}",
        )
    return tuple(facilities), raw_by_id, schedules


def _state_name(
    raw_state: str,
    *,
    closure_category: str,
) -> str:
    if raw_state == "open":
        return "open"
    if raw_state == "closed":
        return "scheduled_closed"
    if raw_state == "unknown":
        return "unknown_hours"
    if raw_state == "temporarily_closed":
        return {
            "seasonal": "seasonal_closed",
            "construction": "construction_closed",
            "temporary": "temporary_closed",
            "none": "temporary_closed",
        }[closure_category]
    raise _fail(
        "FG03_CONTRACT_INVALID",
        f"unsupported Phase 1 facility state {raw_state!r}",
    )


def _scheduled_state(schedule, weekday: int, minute: int) -> str:
    return {
        Availability.OPEN: "open",
        Availability.CLOSED: "closed",
        Availability.UNKNOWN: "unknown",
        Availability.TEMPORARILY_CLOSED: "unknown",
    }[
        availability_at(
            schedule,
            weekday=weekday,
            minute=minute,
            temporarily_closed=False,
        )
    ]


def _load_facility_snapshots(
    proof_dir: Path,
    facilities: tuple[FacilityEvidence, ...],
    raw_by_id: dict[str, dict[str, str]],
    schedules: dict[str, object],
) -> tuple[FacilitySnapshot, ...]:
    facility_by_id = {item.facility_id: item for item in facilities}
    observed_rows = {
        (row["facility_id"], row["snapshot"]): row["state"]
        for row in _read_csv(proof_dir / "facility-states.csv")
    }
    snapshots = []
    for snapshot_id, (weekday, minute, _gtfs_minute) in SNAPSHOTS.items():
        for facility in facilities:
            key = (facility.facility_id, snapshot_id)
            if key not in observed_rows:
                raise _fail(
                    "FG03_CONTRACT_INVALID",
                    f"facility state is missing for {facility.facility_id} at {snapshot_id}",
                )
            snapshots.append(
                FacilitySnapshot(
                    facility_id=facility.facility_id,
                    snapshot_id=snapshot_id,
                    scheduled_state=_scheduled_state(
                        schedules[facility.facility_id],
                        weekday,
                        minute,
                    ),
                    observed_state=_state_name(
                        observed_rows[key],
                        closure_category=facility.closure_category,
                    ),
                )
            )
    for snapshot_id, (weekday, minute, _gtfs_minute) in SATURDAY_SNAPSHOTS.items():
        for facility in facilities:
            raw = raw_by_id[facility.facility_id]
            scheduled = _scheduled_state(
                schedules[facility.facility_id],
                weekday,
                minute,
            )
            raw_state = (
                "temporarily_closed"
                if _bool(raw.get("temporarily_closed"))
                else scheduled
            )
            observed = _state_name(
                raw_state,
                closure_category=facility.closure_category,
            )
            snapshots.append(
                FacilitySnapshot(
                    facility_id=facility.facility_id,
                    snapshot_id=snapshot_id,
                    scheduled_state=scheduled,
                    observed_state=observed,
                )
            )
    return tuple(snapshots)


def _load_events(
    gtfs_path: Path,
    service_date: date,
    boundary,
    *,
    windows: dict[str, tuple[int, int]],
) -> dict[str, tuple[ActiveStopEvent, ...]]:
    loaded = active_stop_events_for_windows(
        gtfs_path,
        service_date,
        windows=windows,
    )
    result = {}
    for snapshot_id, events in loaded.items():
        inside = tuple(
            event
            for event in events
            if boundary.covers(Point(event.lon, event.lat))
        )
        if not inside:
            raise _fail(
                "FG03_NO_ACTIVE_STOPS",
                f"snapshot {snapshot_id} has no active Toronto TTC stops in {gtfs_path}",
            )
        result[snapshot_id] = inside
    return result


def _stop_rows(events: tuple[ActiveStopEvent, ...]) -> dict[str, dict]:
    grouped: dict[str, list[ActiveStopEvent]] = defaultdict(list)
    for event in events:
        grouped[event.stop_id].append(event)
    return {
        stop_id: {
            "id": stop_id,
            "name": items[0].stop_name,
            "parentStation": items[0].parent_station_name,
            "lon": items[0].lon,
            "lat": items[0].lat,
            "eventCount": len(items),
            "uniqueTripCount": len({item.trip_id for item in items}),
            "routeCount": len({item.route_id for item in items}),
        }
        for stop_id, items in grouped.items()
    }


def _scenario(
    scenario_id: str,
    service_date: date,
    snapshot_ids: tuple[str, ...],
    *,
    access: str = "public",
    walk: int = 400,
    closure: str = "observed",
    information: str = "unknown_unavailable",
) -> Scenario:
    return Scenario(
        scenario_id=scenario_id,
        service_date=service_date,
        snapshot_ids=snapshot_ids,
        access_mode=access,
        walking_distance=walk,
        closure_mode=closure,
        information_mode=information,
    )


class AnalysisEngine:
    def __init__(
        self,
        network,
        facilities,
        facility_snapshots,
        facility_snaps,
        stop_snaps,
        events_by_snapshot,
    ):
        self.network = network
        self.facilities = tuple(facilities)
        self.facility_by_id = {item.facility_id: item for item in facilities}
        self.snapshots = {
            (item.facility_id, item.snapshot_id): item
            for item in facility_snapshots
        }
        self.facility_snaps = facility_snaps
        self.stop_snaps = stop_snaps
        self.events = events_by_snapshot
        self.baseline_cache = {}
        self.candidate_cache = {}
        self.baseline_searches = 0
        self.candidate_searches = 0
        self.candidate_cache_hits = 0

    def _facility_is_available(
        self,
        facility: FacilityEvidence,
        scenario: Scenario,
        snapshot_id: str,
        *,
        accessible_only: bool,
    ) -> bool:
        if accessible_only and facility.accessibility != "accessible":
            return False
        state = effective_facility_state(
            self.snapshots[(facility.facility_id, snapshot_id)],
            scenario,
        )
        return state in {"open", "potential_open"}

    def baseline_distances(
        self,
        scenario: Scenario,
        snapshot_id: str,
        *,
        accessible_only: bool = False,
    ):
        key = (
            scenario.service_date.isoformat(),
            snapshot_id,
            scenario.access_mode,
            scenario.closure_mode,
            scenario.information_mode,
            accessible_only,
        )
        if key in self.baseline_cache:
            return self.baseline_cache[key]
        permitted = eligible_facilities(
            self.facilities,
            access_mode=scenario.access_mode,
        )
        sources = {}
        for facility in permitted:
            if not self._facility_is_available(
                facility,
                scenario,
                snapshot_id,
                accessible_only=accessible_only,
            ):
                continue
            snap = self.facility_snaps[facility.facility_id]
            sources[snap.node] = min(
                sources.get(snap.node, math.inf),
                snap.offset_metres,
            )
        distances = _multi_source_distances(
            self.network.graph,
            sources,
            cutoff=500.0,
        )
        self.baseline_cache[key] = distances
        self.baseline_searches += 1
        return distances

    def covered_stops(
        self,
        scenario: Scenario,
        snapshot_id: str,
        *,
        accessible_only: bool = False,
    ) -> frozenset[str]:
        distances = self.baseline_distances(
            scenario,
            snapshot_id,
            accessible_only=accessible_only,
        )
        return frozenset(
            event.stop_id
            for event in self.events[snapshot_id]
            if (
                event.stop_id in self.stop_snaps
                and distances.get(
                    self.stop_snaps[event.stop_id].node,
                    math.inf,
                )
                + self.stop_snaps[event.stop_id].offset_metres
                <= scenario.walking_distance
            )
        )

    def candidate_distances(self, node):
        if node in self.candidate_cache:
            self.candidate_cache_hits += 1
            return self.candidate_cache[node]
        distances = nx.single_source_dijkstra_path_length(
            self.network.graph,
            node,
            cutoff=500.0,
            weight="length",
        )
        self.candidate_cache[node] = distances
        self.candidate_searches += 1
        return distances

    def footprint(
        self,
        source_id: str,
        node,
        source_offset: float,
        scenario: Scenario,
    ) -> CoverageFootprint:
        distances = self.candidate_distances(node)
        by_snapshot = {}
        for snapshot_id in scenario.snapshot_ids:
            by_snapshot[snapshot_id] = frozenset(
                event.stop_id
                for event in self.events[snapshot_id]
                if (
                    source_offset
                    + distances.get(self.stop_snaps[event.stop_id].node, math.inf)
                    + self.stop_snaps[event.stop_id].offset_metres
                    <= scenario.walking_distance
                )
            )
        return CoverageFootprint(
            source_id=source_id,
            node_id=f"{node[0]:.3f},{node[1]:.3f}",
            stops_by_snapshot=by_snapshot,
        )

    def inputs(
        self,
        scenario: Scenario,
        *,
        accessible_only: bool = False,
    ) -> ScenarioInputs:
        return ScenarioInputs(
            scenario=scenario,
            snapshot_events=tuple(
                SnapshotEvents(snapshot_id, self.events[snapshot_id])
                for snapshot_id in scenario.snapshot_ids
            ),
            baseline_covered=tuple(
                SnapshotStops(
                    snapshot_id,
                    self.covered_stops(
                        scenario,
                        snapshot_id,
                        accessible_only=accessible_only,
                    ),
                )
                for snapshot_id in scenario.snapshot_ids
            ),
        )

    def facility_footprints(self, scenario: Scenario):
        return {
            facility.facility_id: self.footprint(
                facility.facility_id,
                self.facility_snaps[facility.facility_id].node,
                self.facility_snaps[facility.facility_id].offset_metres,
                scenario,
            )
            for facility in self.facilities
        }

    def nearest_categories(
        self,
        scenario: Scenario,
        snapshot_id: str,
        stop_id: str,
    ) -> dict[str, NearestFacility | None]:
        nearest = {
            "documented": None,
            "open": None,
            "scheduled_closed": None,
            "seasonal_closed": None,
            "temporary_closed": None,
            "construction_closed": None,
            "unknown_hours": None,
            "open_accessible": None,
            "open_unknown_accessibility": None,
            "open_inaccessible": None,
        }
        stop_snap = self.stop_snaps[stop_id]
        for facility in eligible_facilities(
            self.facilities,
            access_mode=scenario.access_mode,
        ):
            facility_snap = self.facility_snaps[facility.facility_id]
            distance = (
                facility_snap.offset_metres
                + self.candidate_distances(facility_snap.node).get(
                    stop_snap.node,
                    math.inf,
                )
                + stop_snap.offset_metres
            )
            if not math.isfinite(distance):
                continue
            evidence = NearestFacility(
                facility.facility_id,
                facility.name,
                distance,
            )
            state = effective_facility_state(
                self.snapshots[(facility.facility_id, snapshot_id)],
                scenario,
            )
            categories = ["documented"]
            if state in {"open", "potential_open"}:
                categories.append("open")
                categories.append(f"open_{facility.accessibility}")
            else:
                categories.append(state)
            for category in categories:
                if category not in nearest:
                    continue
                prior = nearest[category]
                if prior is None or distance < prior.network_distance:
                    nearest[category] = evidence
        return nearest


def _analysis_scenarios(snapshot_date: date):
    primary = _scenario(
        "primary",
        snapshot_date,
        ("2200", "0030"),
    )
    sensitivities = (
        _scenario(
            "distance-300",
            snapshot_date,
            ("2200", "0030"),
            walk=300,
        ),
        _scenario(
            "distance-500",
            snapshot_date,
            ("2200", "0030"),
            walk=500,
        ),
        _scenario(
            "rider-conditional",
            snapshot_date,
            ("2200", "0030"),
            access="rider_conditional",
        ),
        _scenario(
            "normal-operations",
            snapshot_date,
            ("2200", "0030"),
            closure="normal_operations",
        ),
        _scenario(
            "optimistic-information",
            snapshot_date,
            ("2200", "0030"),
            information="optimistic_information",
        ),
        _scenario(
            "saturday",
            date(2026, 7, 25),
            ("sat-2200", "sat-0030"),
        ),
    )
    return primary, sensitivities


def _build_candidates(engine: AnalysisEngine, snapshot_date: date):
    primary, sensitivities = _analysis_scenarios(snapshot_date)
    primary_inputs = engine.inputs(primary)
    sensitivity_inputs = tuple(engine.inputs(item) for item in sensitivities)
    primary_accessible_inputs = engine.inputs(primary, accessible_only=True)
    sensitivity_accessible_inputs = tuple(
        engine.inputs(item, accessible_only=True) for item in sensitivities
    )
    primary_footprints = engine.facility_footprints(primary)
    sensitivity_footprints = {
        scenario.scenario_id: engine.facility_footprints(scenario)
        for scenario in sensitivities
    }

    hours = simulate_hours_extensions(
        primary_inputs,
        sensitivity_inputs=sensitivity_inputs,
        facilities=engine.facilities,
        snapshots=engine.snapshots.values(),
        footprints=primary_footprints,
        sensitivity_footprints=sensitivity_footprints,
    )

    primary_uncovered = {
        snapshot_id: frozenset(
            event.stop_id
            for event in engine.events[snapshot_id]
        ).difference(engine.covered_stops(primary, snapshot_id))
        for snapshot_id in primary.snapshot_ids
    }
    seed_by_stop = {}
    stop_event_lookup = {
        event.stop_id: event
        for snapshot_id in primary.snapshot_ids
        for event in engine.events[snapshot_id]
    }
    for stop_id in sorted(set().union(*primary_uncovered.values())):
        event = stop_event_lookup[stop_id]
        snap = engine.stop_snaps[stop_id]
        lon, lat = Transformer.from_crs(2952, 4326, always_xy=True).transform(
            snap.node[0],
            snap.node[1],
        )
        seed_by_stop[stop_id] = NewFacilitySeed(
            representative_stop_id=stop_id,
            name=event.parent_station_name or event.stop_name,
            lon=lon,
            lat=lat,
            node_id=f"{snap.node[0]:.3f},{snap.node[1]:.3f}",
            footprint=engine.footprint(stop_id, snap.node, 0.0, primary),
        )
    sensitivity_seeds = {}
    for scenario in sensitivities:
        sensitivity_seeds[scenario.scenario_id] = tuple(
            NewFacilitySeed(
                representative_stop_id=seed.representative_stop_id,
                name=seed.name,
                lon=seed.lon,
                lat=seed.lat,
                node_id=seed.node_id,
                footprint=engine.footprint(
                    seed.representative_stop_id,
                    engine.stop_snaps[seed.representative_stop_id].node,
                    0.0,
                    scenario,
                ),
            )
            for seed in seed_by_stop.values()
        )
    new_zones = simulate_new_facility_zones(
        primary_inputs,
        sensitivity_inputs=sensitivity_inputs,
        seeds=seed_by_stop.values(),
        sensitivity_seeds=sensitivity_seeds,
    )

    states = tuple(engine.snapshots.values())
    hours_facilities = tuple(
        replace(item, accessibility="accessible")
        if item.accessibility == "unknown"
        else item
        for item in engine.facilities
    )
    hours_information = simulate_information_verification(
        primary_inputs,
        sensitivity_inputs=sensitivity_inputs,
        facilities=hours_facilities,
        snapshots=states,
        footprints=primary_footprints,
        sensitivity_footprints=sensitivity_footprints,
    )
    hours_information = tuple(
        item
        for item in hours_information
        if item.verification_kind == "hours"
    )
    original_by_id = {
        item.facility_id: item for item in engine.facilities
    }
    hours_information = tuple(
        replace(item, facility=original_by_id[item.facility_id])
        for item in hours_information
    )

    accessibility_states = tuple(
        replace(
            state,
            observed_state=(
                "scheduled_closed"
                if state.observed_state == "unknown_hours"
                else state.observed_state
            ),
        )
        for state in states
    )
    accessibility_information = simulate_information_verification(
        primary_accessible_inputs,
        sensitivity_inputs=sensitivity_accessible_inputs,
        facilities=engine.facilities,
        snapshots=accessibility_states,
        footprints=primary_footprints,
        sensitivity_footprints=sensitivity_footprints,
    )
    accessibility_information = tuple(
        item
        for item in accessibility_information
        if item.verification_kind == "accessibility"
    )

    retrofits = simulate_accessibility_retrofits(
        primary_accessible_inputs,
        sensitivity_inputs=sensitivity_accessible_inputs,
        facilities=engine.facilities,
        snapshots=states,
        footprints=primary_footprints,
        sensitivity_footprints=sensitivity_footprints,
    )
    candidates = tuple(
        sorted(
            (
                *hours,
                *new_zones,
                *hours_information,
                *accessibility_information,
                *retrofits,
            ),
            key=lambda item: item.candidate_id,
        )
    )
    return candidates, primary, sensitivities, len(seed_by_stop)


def _metric_counts(events: Iterable[ActiveStopEvent]) -> dict[str, int]:
    items = tuple(events)
    return {
        "uniqueTrips": len({item.trip_id for item in items}),
        "uniqueRoutes": len({item.route_id for item in items}),
        "activeStops": len({item.stop_id for item in items}),
        "events": len(items),
    }


def _candidate_active(
    candidate: CandidateGain,
    engine: AnalysisEngine,
    scenario: Scenario,
    snapshot_id: str,
) -> bool:
    if (
        candidate.facility is not None
        and candidate.facility.access_condition == "fare_paid"
        and scenario.access_mode == "public"
    ):
        return False
    if candidate.candidate_class == "new_facility_zone":
        return True
    state = effective_facility_state(
        engine.snapshots[(candidate.facility_id, snapshot_id)],
        scenario,
    )
    if candidate.candidate_class == "extend_hours":
        return state == "scheduled_closed"
    if candidate.candidate_class == "verify_information":
        if candidate.verification_kind == "hours":
            return state == "unknown_hours"
        return state in {"open", "potential_open"}
    if candidate.candidate_class == "retrofit_accessibility":
        return state in {"open", "potential_open"}
    return False


def _query_cells(candidate: CandidateGain, engine: AnalysisEngine, snapshot_date: date):
    if candidate.candidate_class == "new_facility_zone":
        source_node = engine.stop_snaps[candidate.source_stop_id].node
        source_offset = 0.0
    else:
        snap = engine.facility_snaps[candidate.facility_id]
        source_node = snap.node
        source_offset = snap.offset_metres
    distances = engine.candidate_distances(source_node)
    cells = []
    for snapshot_id in SNAPSHOTS:
        for access in ACCESS_MODES:
            for walk in WALKS:
                scenario = _scenario(
                    f"query-{snapshot_id}-{access}-{walk}",
                    snapshot_date,
                    (snapshot_id,),
                    access=access,
                    walk=walk,
                )
                accessible_only = (
                    candidate.candidate_class == "retrofit_accessibility"
                    or (
                        candidate.candidate_class == "verify_information"
                        and candidate.verification_kind == "accessibility"
                    )
                )
                baseline = engine.covered_stops(
                    scenario,
                    snapshot_id,
                    accessible_only=accessible_only,
                )
                catchment = frozenset(
                    event.stop_id
                    for event in engine.events[snapshot_id]
                    if (
                        source_offset
                        + distances.get(engine.stop_snaps[event.stop_id].node, math.inf)
                        + engine.stop_snaps[event.stop_id].offset_metres
                        <= walk
                    )
                )
                if not _candidate_active(candidate, engine, scenario, snapshot_id):
                    catchment = frozenset()
                incremental = catchment.difference(baseline)
                metrics = _metric_counts(
                    event
                    for event in engine.events[snapshot_id]
                    if event.stop_id in incremental
                )
                cells.append(
                    {
                        "time": snapshot_id,
                        "access": access,
                        "walk": walk,
                        "active": bool(catchment),
                        **metrics,
                    }
                )
    return cells


def _candidate_group(candidate: CandidateGain) -> str:
    if candidate.candidate_class == "extend_hours":
        return "extend"
    if candidate.candidate_class == "new_facility_zone":
        return "new"
    if candidate.verification_kind == "hours":
        return "verify-hours"
    if candidate.verification_kind == "accessibility":
        return "verify-accessibility"
    return "retrofit"


def _analysis_hash(
    candidates: tuple[CandidateGain, ...],
    audit_candidates: tuple[CandidateGain, ...],
    engine: AnalysisEngine,
    primary: Scenario,
    snapshot_date: str,
    source_paths: dict[str, Path],
) -> str:
    candidate_projections = []
    for candidate in candidates:
        projection = candidate_public_projection(candidate)
        projection["audit_status"] = "source review"
        candidate_projections.append(projection)
    audit_contexts = []
    for candidate in audit_candidates:
        snap, source_offset, gained_stop_ids = _candidate_map_context(
            candidate,
            engine,
            primary,
        )
        reach = _reach_geometry(
            engine,
            snap.node,
            source_offset,
            primary.walking_distance,
        )
        audit_contexts.append(
            {
                "candidateId": candidate.candidate_id,
                "canonicalNetworkNode": [
                    round(snap.node[0], 3),
                    round(snap.node[1], 3),
                ],
                "sourceOffsetMetres": round(source_offset, 3),
                "gainedStopIds": sorted(gained_stop_ids),
                "reach400Sha256": hashlib.sha256(reach.wkb).hexdigest(),
            }
        )
    return _analysis_fingerprint(
        snapshot_date=snapshot_date,
        candidate_projections=candidate_projections,
        audit_contexts=audit_contexts,
        source_paths=source_paths,
    )


def _audit_candidates(candidates: tuple[CandidateGain, ...]):
    selected = []
    for group in (
        "extend",
        "new",
        "verify-hours",
        "verify-accessibility",
        "retrofit",
    ):
        items = sorted(
            (
                item
                for item in candidates
                if _candidate_group(item) == group and item.stability == "robust"
            ),
            key=lambda item: (
                item.primary_rank if item.primary_rank is not None else math.inf,
                item.candidate_id,
            ),
        )
        selected.extend(items[:10])
    return tuple(selected)


def _apply_audit_decisions(
    candidates: tuple[CandidateGain, ...],
    audit_candidates: tuple[CandidateGain, ...],
    analysis_hash: str,
    decisions_path: Path,
):
    rows = [row for row in _read_csv(decisions_path) if row.get("candidate_id")]
    decision_id_counts = Counter(row["candidate_id"] for row in rows)
    duplicate_ids = sorted(
        candidate_id
        for candidate_id, count in decision_id_counts.items()
        if count > 1
    )
    if duplicate_ids:
        raise _fail(
            "FG03_AUDIT_INVALID",
            f"duplicate audit decisions found for {', '.join(duplicate_ids[:5])}; keep one attributed decision per candidate",
        )
    for row in rows:
        if row.get("audit_status") not in {"valid", "exclude"}:
            continue
        missing_fields = [
            field
            for field in ("evidence_note", "reviewer", "reviewed_at")
            if not row.get(field, "").strip()
        ]
        if missing_fields:
            raise _fail(
                "FG03_AUDIT_INVALID",
                f"{row['candidate_id']} is resolved but lacks {', '.join(missing_fields)}",
            )
        reviewed_at = row["reviewed_at"].strip()
        try:
            parsed_review_date = date.fromisoformat(reviewed_at)
        except ValueError as error:
            raise _fail(
                "FG03_AUDIT_INVALID",
                f"{row['candidate_id']} reviewed_at must be an ISO date in YYYY-MM-DD form",
            ) from error
        if parsed_review_date.isoformat() != reviewed_at:
            raise _fail(
                "FG03_AUDIT_INVALID",
                f"{row['candidate_id']} reviewed_at must be an ISO date in YYYY-MM-DD form",
            )
    decisions = {row["candidate_id"]: row for row in rows}
    required_ids = {item.candidate_id for item in audit_candidates}
    stale = sorted(
        candidate_id
        for candidate_id in required_ids
        if candidate_id in decisions
        and decisions[candidate_id].get("analysis_hash") != analysis_hash
    )
    missing = sorted(required_ids.difference(decisions))
    pending = sorted(
        candidate_id
        for candidate_id in required_ids
        if candidate_id in decisions
        and decisions[candidate_id].get("audit_status")
        not in {"valid", "exclude"}
    )
    if stale:
        audit_reason = (
            "FG03_AUDIT_STALE: curated decisions have a different analysis hash "
            f"for {', '.join(stale[:5])}; refresh the curated Phase 2 audit decisions"
        )
    elif missing or pending:
        affected = missing + pending
        audit_reason = (
            "FG03_AUDIT_INCOMPLETE: required audit decisions are unresolved for "
            f"{', '.join(affected[:5])}; review the curated Phase 2 audit decisions"
        )
    else:
        audit_reason = ""
    updated = []
    for candidate in candidates:
        decision = decisions.get(candidate.candidate_id)
        status = (
            decision["audit_status"]
            if decision
            and decision.get("analysis_hash") == analysis_hash
            and decision.get("audit_status") in {"valid", "exclude"}
            else "source review"
        )
        updated.append(replace(candidate, audit_status=status))
    return tuple(updated), decisions, audit_reason


def _candidate_metric_columns(candidate: CandidateGain):
    values = {
        "primary_rank": candidate.primary_rank,
        "primary_unique_trips": candidate.primary_metrics.combined_incremental.unique_trips,
        "primary_unique_routes": candidate.primary_metrics.combined_incremental.unique_routes,
        "primary_active_stops": candidate.primary_metrics.combined_incremental.active_stops,
        "primary_events": candidate.primary_metrics.combined_incremental.stop_time_events,
    }
    by_id = {
        item.scenario_id: item for item in candidate.sensitivity_metrics
    }
    rank_by_id = {
        item.scenario_id: item.published_rank
        for item in candidate.sensitivity_ranks
    }
    for scenario_id in (
        "distance-300",
        "distance-500",
        "rider-conditional",
        "normal-operations",
        "optimistic-information",
        "saturday",
    ):
        prefix = scenario_id.replace("-", "_")
        values[f"{prefix}_rank"] = rank_by_id.get(
            scenario_id,
            "not applicable",
        )
        metrics = by_id.get(scenario_id)
        values[f"{prefix}_unique_trips"] = (
            metrics.combined_incremental.unique_trips
            if metrics is not None
            else "not applicable"
        )
        values[f"{prefix}_unique_routes"] = (
            metrics.combined_incremental.unique_routes
            if metrics is not None
            else "not applicable"
        )
        values[f"{prefix}_active_stops"] = (
            metrics.combined_incremental.active_stops
            if metrics is not None
            else "not applicable"
        )
    return values


def _audit_rows(
    audit_candidates,
    analysis_hash,
    decisions,
    engine,
    primary,
):
    rows = []
    for candidate in audit_candidates:
        if candidate.candidate_class == "new_facility_zone":
            snap = engine.stop_snaps[candidate.source_stop_id]
            source_reference = f"GTFS stops.txt stop_id={candidate.source_stop_id}"
            source_url = "https://www.ttc.ca/transparency-and-accountability/open-data"
            access = "unrestricted"
            hours = "proposed always-open investigation zone"
            closure = "none"
            accessibility = "unknown"
            partial = False
        else:
            snap = engine.facility_snaps[candidate.facility_id]
            source_reference = (
                f"Phase 1 facilities.csv facility_id={candidate.facility_id}"
            )
            source_url = candidate.facility.source_url
            access = candidate.facility.access_condition
            hours = candidate.facility.hours
            closure = candidate.facility.closure_category
            accessibility = candidate.facility.accessibility
            partial = candidate.facility.partial_service
        source_to_snap = snap.offset_metres
        nearest = engine.nearest_categories(
            primary,
            "2200",
            (
                candidate.source_stop_id
                if candidate.source_stop_id
                else min(
                    engine.stop_snaps,
                    key=lambda stop_id: engine.candidate_distances(snap.node).get(
                        engine.stop_snaps[stop_id].node,
                        math.inf,
                    )
                    + engine.stop_snaps[stop_id].offset_metres,
                )
            ),
        )
        nearest_values = sorted(
            {
                (item.network_distance, item.facility_id, item.name)
                for item in nearest.values()
                if item is not None
            }
        )[:3]
        other_facilities = []
        for facility in engine.facilities:
            if facility.facility_id == candidate.facility_id:
                continue
            distance = (
                source_to_snap
                + engine.candidate_distances(snap.node).get(
                    engine.facility_snaps[facility.facility_id].node,
                    math.inf,
                )
                + engine.facility_snaps[facility.facility_id].offset_metres
            )
            if math.isfinite(distance):
                other_facilities.append((distance, facility.facility_id, facility.name))
        other_facilities.sort()
        decision = decisions.get(candidate.candidate_id, {})
        rows.append(
            {
                "analysis_hash": analysis_hash,
                "candidate_id": candidate.candidate_id,
                "action": candidate.candidate_class,
                "ranking_group": _candidate_group(candidate),
                "name": candidate.name,
                "lon": f"{candidate.lon:.7f}",
                "lat": f"{candidate.lat:.7f}",
                "source_reference": source_reference,
                "source_url": source_url,
                **_candidate_metric_columns(candidate),
                "hours": hours,
                "closure_category": closure,
                "access_condition": access,
                "accessibility": accessibility,
                "partial_service": str(partial).lower(),
                "source_to_snap_metres": f"{source_to_snap:.1f}",
                "nearest_relevant": " | ".join(
                    f"{facility_id}:{name}:{distance:.1f}m"
                    for distance, facility_id, name in nearest_values
                ),
                "nearest_other_facilities": " | ".join(
                    f"{facility_id}:{name}:{distance:.1f}m"
                    for distance, facility_id, name in other_facilities[:3]
                ),
                "canonical_network_node": f"{snap.node[0]:.3f},{snap.node[1]:.3f}",
                "duplicate_flag": str(candidate.duplicate_candidate).lower(),
                "inferred_action": _candidate_group(candidate),
                "audit_map_path": (
                    f"audit-maps/{candidate.candidate_id.replace(':', '_')}.png"
                ),
                "audit_status": decision.get("audit_status", "source review"),
                "evidence_note": decision.get("evidence_note", ""),
                "reviewer": decision.get("reviewer", ""),
                "reviewed_at": decision.get("reviewed_at", ""),
            }
        )
    return rows


def _orient_edge_geometry(geometry, node):
    start = (round(geometry.coords[0][0], 3), round(geometry.coords[0][1], 3))
    if start == node:
        return geometry
    return LineString(reversed(geometry.coords))


def _reach_geometry(engine: AnalysisEngine, node, source_offset: float, walk: int):
    budget = walk - source_offset
    if budget <= 0:
        return MultiLineString([])
    distances = engine.candidate_distances(node)
    pieces = []
    seen_edges = set()
    for start in sorted(distances):
        for end, edge in sorted(engine.network.graph[start].items()):
            edge_key = (start, end) if start <= end else (end, start)
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            edge_cost = float(edge["length"])
            if edge_cost <= 0:
                continue
            start_fraction = min(
                1.0,
                max(0.0, (budget - distances.get(start, math.inf)) / edge_cost),
            )
            end_fraction = min(
                1.0,
                max(0.0, (budget - distances.get(end, math.inf)) / edge_cost),
            )
            if start_fraction <= 0 and end_fraction <= 0:
                continue
            geometry = _orient_edge_geometry(edge["geometry"], start)
            if start_fraction + end_fraction >= 1.0:
                pieces.append(geometry)
                continue
            start_reach = geometry.length * start_fraction
            end_reach = geometry.length * end_fraction
            if start_reach > 0:
                clipped = substring(geometry, 0, start_reach)
                if clipped.geom_type == "LineString" and clipped.length > 0:
                    pieces.append(LineString(clipped.coords))
            if end_reach > 0:
                clipped = substring(
                    geometry,
                    geometry.length - end_reach,
                    geometry.length,
                )
                if clipped.geom_type == "LineString" and clipped.length > 0:
                    pieces.append(LineString(clipped.coords))
    return MultiLineString([list(piece.coords) for piece in pieces])


def _to_lonlat_geometry(geometry):
    transformer = Transformer.from_crs(2952, 4326, always_xy=True)
    return MultiLineString(
        [
            [transformer.transform(x, y) for x, y in line.coords]
            for line in geometry.geoms
        ]
    )


def _reach_features(
    engine: AnalysisEngine,
    places: Iterable[tuple[str, tuple[float, float], float, str]],
    public_place_ids: dict[str, str],
):
    features = []
    for place_id, node, offset, access_condition in sorted(places):
        public_place_id = public_place_ids[place_id]
        for walk in WALKS:
            geometry = _to_lonlat_geometry(
                _reach_geometry(engine, node, offset, walk)
            )
            features.append(
                {
                    "type": "Feature",
                    "id": _public_reach_id(public_place_id, walk),
                    "geometry": geometry.__geo_interface__,
                    "properties": {
                        "schemaVersion": 1,
                        "placeId": public_place_id,
                        "walk": walk,
                        "accessCondition": access_condition,
                    },
                }
            )
    return features


def _public_facilities(
    facilities,
    snapshots,
    public_place_ids,
):
    states = {
        (item.facility_id, item.snapshot_id): item
        for item in snapshots
    }
    features = []
    for facility in sorted(facilities, key=lambda item: item.facility_id):
        public_place_id = public_place_ids[facility.facility_id]
        features.append(
            {
                "type": "Feature",
                "id": public_place_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [facility.lon, facility.lat],
                },
                "properties": {
                    "schemaVersion": 1,
                    "id": public_place_id,
                    "name": facility.name,
                    "source": facility.source,
                    "address": facility.address,
                    "hours": facility.hours,
                    "accessCondition": facility.access_condition,
                    "closureCategory": facility.closure_category,
                    "accessibility": facility.accessibility,
                    "partialService": facility.partial_service,
                    "stateByTime": {
                        snapshot_id: {
                            "scheduled": states[
                                (facility.facility_id, snapshot_id)
                            ].scheduled_state,
                            "observed": states[
                                (facility.facility_id, snapshot_id)
                            ].observed_state,
                        }
                        for snapshot_id in SNAPSHOTS
                    },
                    "sourceUrl": facility.source_url,
                    "reachAvailable": True,
                },
            }
        )
    return features


def _public_stop_features(
    snapshot_id,
    rows,
    engine,
    snapshot_date,
):
    coverage = {}
    gaps = {}
    for access in ACCESS_MODES:
        coverage[access] = {}
        for walk in WALKS:
            scenario = _scenario(
                f"browser-{snapshot_id}-{access}-{walk}",
                snapshot_date,
                (snapshot_id,),
                access=access,
                walk=walk,
            )
            coverage[access][str(walk)] = engine.covered_stops(
                scenario,
                snapshot_id,
            )
    gap_scenario = _scenario(
        f"gap-{snapshot_id}",
        snapshot_date,
        (snapshot_id,),
        walk=400,
    )
    for stop_id in rows:
        gaps[stop_id] = classify_gap(
            stop_id=stop_id,
            scenario=gap_scenario,
            nearest=engine.nearest_categories(
                gap_scenario,
                snapshot_id,
                stop_id,
            ),
        )
    features = []
    for stop_id, row in sorted(rows.items()):
        gap = gaps[stop_id]
        features.append(
            {
                "type": "Feature",
                "id": f"stop:{stop_id}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [row["lon"], row["lat"]],
                },
                "properties": {
                    "schemaVersion": 1,
                    "id": f"stop:{stop_id}",
                    "snapshot": snapshot_id,
                    "name": row["name"],
                    "parentStation": row["parentStation"],
                    "eventCount": row["eventCount"],
                    "uniqueTripCount": row["uniqueTripCount"],
                    "routeCount": row["routeCount"],
                    "coverage": {
                        access: {
                            str(walk): stop_id in coverage[access][str(walk)]
                            for walk in WALKS
                        }
                        for access in ACCESS_MODES
                    },
                    "gaps": {
                        "geographic": gap.geographic_gap,
                        "scheduledTime": gap.scheduled_time_gap,
                        "seasonal": gap.seasonal_gap,
                        "temporaryService": gap.temporary_service_gap,
                        "accessibility": gap.accessibility_gap,
                        "information": gap.information_gap,
                    },
                    "reachAvailable": False,
                },
            }
        )
    return features, gaps


def _public_interventions(
    candidates,
    engine,
    snapshot_date,
    public_place_ids,
):
    features = []
    places = []
    for candidate in sorted(candidates, key=lambda item: item.candidate_id):
        if candidate.audit_status != "valid" or candidate.stability != "robust":
            continue
        projection = candidate_public_projection(candidate)
        public_place_id = public_place_ids[projection["candidate_id"]]
        if candidate.candidate_class == "new_facility_zone":
            snap = engine.stop_snaps[candidate.source_stop_id]
            node = snap.node
            offset = 0.0
            access = "unrestricted"
            hours = "investigation zone"
            closure = "none"
            accessibility = "unknown"
            source_url = "https://www.ttc.ca/transparency-and-accountability/open-data"
        else:
            snap = engine.facility_snaps[candidate.facility_id]
            node = snap.node
            offset = snap.offset_metres
            access = projection["facility"]["access_condition"]
            hours = projection["facility"]["hours"]
            closure = projection["facility"]["closure_category"]
            accessibility = projection["facility"]["accessibility"]
            source_url = projection["facility"]["source_url"]
        properties = {
            "schemaVersion": 1,
            "id": public_place_id,
            "action": PUBLIC_ACTION_BY_CLASS[projection["candidate_class"]],
            "actionClass": projection["candidate_class"],
            "verificationSubtype": projection["verification_kind"],
            "name": projection["name"],
            "facilityId": (
                public_place_ids[projection["facility_id"]]
                if projection["facility_id"] is not None
                else None
            ),
            "accessCondition": access,
            "hours": hours,
            "closureCategory": closure,
            "accessibility": accessibility,
            "sourceUrl": source_url,
            "auditStatus": projection["audit_status"],
            "stability": projection["stability"],
            "materialGain": projection["material_gain"],
            "primaryRank": projection["primary_rank"],
            "primaryMetrics": projection["primary_metrics"],
            "sensitivityRanks": projection["sensitivity_ranks"],
            "queryCells": _query_cells(candidate, engine, snapshot_date),
            "reachAvailable": True,
        }
        features.append(
            {
                "type": "Feature",
                "id": public_place_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [candidate.lon, candidate.lat],
                },
                "properties": properties,
            }
        )
        places.append((candidate.candidate_id, node, offset, access))
    return features, places


def _snap_diagnostics(snaps) -> dict[str, float | int]:
    offsets = sorted(item.offset_metres for item in snaps.values())
    if not offsets:
        return {
            "count": 0,
            "p50Metres": 0.0,
            "p95Metres": 0.0,
            "p99Metres": 0.0,
            "maxMetres": 0.0,
            "over200Metres": 0,
        }

    def percentile(percent: float) -> float:
        position = (len(offsets) - 1) * percent / 100
        lower = math.floor(position)
        upper = math.ceil(position)
        if lower == upper:
            return offsets[lower]
        return offsets[lower] + (offsets[upper] - offsets[lower]) * (position - lower)

    return {
        "count": len(offsets),
        "p50Metres": percentile(50),
        "p95Metres": percentile(95),
        "p99Metres": percentile(99),
        "maxMetres": offsets[-1],
        "over200Metres": sum(value > 200 for value in offsets),
    }


def _candidate_map_context(
    candidate: CandidateGain,
    engine: AnalysisEngine,
    primary: Scenario,
):
    if candidate.candidate_class == "new_facility_zone":
        snap = engine.stop_snaps[candidate.source_stop_id]
        source_offset = 0.0
    else:
        snap = engine.facility_snaps[candidate.facility_id]
        source_offset = snap.offset_metres
    accessible_only = (
        candidate.candidate_class == "retrofit_accessibility"
        or (
            candidate.candidate_class == "verify_information"
            and candidate.verification_kind == "accessibility"
        )
    )
    distances = engine.candidate_distances(snap.node)
    gained_stop_ids = set()
    for snapshot_id in primary.snapshot_ids:
        if not _candidate_active(candidate, engine, primary, snapshot_id):
            continue
        baseline = engine.covered_stops(
            primary,
            snapshot_id,
            accessible_only=accessible_only,
        )
        catchment = {
            event.stop_id
            for event in engine.events[snapshot_id]
            if (
                source_offset
                + distances.get(engine.stop_snaps[event.stop_id].node, math.inf)
                + engine.stop_snaps[event.stop_id].offset_metres
                <= primary.walking_distance
            )
        }
        gained_stop_ids.update(catchment.difference(baseline))
    return snap, source_offset, gained_stop_ids


def _draw_evidence_map(
    path: Path,
    engine: AnalysisEngine,
    candidate: CandidateGain,
    primary: Scenario,
):
    projector = Transformer.from_crs(4326, 2952, always_xy=True)
    x, y = projector.transform(candidate.lon, candidate.lat)
    snap, source_offset, gained_stop_ids = _candidate_map_context(
        candidate,
        engine,
        primary,
    )
    fig, axis = plt.subplots(figsize=(5, 5), facecolor="#f4f0e7")
    axis.set_facecolor("#f4f0e7")
    for segment in engine.network.source_segments:
        bounds = segment.geometry.bounds
        if (
            bounds[2] < x - 700
            or bounds[0] > x + 700
            or bounds[3] < y - 700
            or bounds[1] > y + 700
        ):
            continue
        xs, ys = segment.geometry.xy
        axis.plot(xs, ys, color="#beb8ad", linewidth=0.45)

    reach = _reach_geometry(
        engine,
        snap.node,
        source_offset,
        primary.walking_distance,
    )
    for line in reach.geoms:
        xs, ys = line.xy
        axis.plot(xs, ys, color="#1d6380", linewidth=1.2, alpha=0.55, zorder=2)

    nearby_facilities = []
    for facility in engine.facilities:
        facility_x, facility_y = projector.transform(facility.lon, facility.lat)
        distance = math.hypot(facility_x - x, facility_y - y)
        if distance > 700:
            continue
        marker = "s" if facility.access_condition == "fare_paid" else "o"
        color = "#1a1f2a" if facility.access_condition == "fare_paid" else "#2c6e6a"
        axis.scatter(
            [facility_x],
            [facility_y],
            s=20,
            marker=marker,
            facecolor=color,
            edgecolor="#f4f0e7",
            linewidth=0.6,
            alpha=0.9,
            zorder=4,
        )
        if facility.facility_id != candidate.facility_id:
            nearby_facilities.append((distance, facility, facility_x, facility_y))

    gained_points = [
        Point(
            engine.stop_snaps[stop_id].projected_x,
            engine.stop_snaps[stop_id].projected_y,
        )
        for stop_id in sorted(gained_stop_ids)
        if stop_id in engine.stop_snaps
    ]
    if gained_points:
        axis.scatter(
            [point.x for point in gained_points],
            [point.y for point in gained_points],
            s=13,
            marker="^",
            color="#784f83",
            alpha=0.8,
            linewidth=0,
            zorder=5,
        )

    snap_x, snap_y = snap.node
    if math.hypot(snap_x - x, snap_y - y) > 0.05:
        axis.plot(
            [x, snap_x],
            [y, snap_y],
            color="#d5563a",
            linewidth=1.0,
            linestyle=(0, (3, 2)),
            zorder=5,
        )
    axis.scatter(
        [snap_x],
        [snap_y],
        s=22,
        marker="x",
        color="#d5563a",
        linewidth=1.3,
        zorder=6,
    )
    axis.scatter(
        [x],
        [y],
        s=72,
        marker="*",
        color="#d5563a",
        edgecolor="#f4f0e7",
        linewidth=0.7,
        zorder=7,
    )

    for _distance, facility, facility_x, facility_y in sorted(nearby_facilities)[:3]:
        label = facility.name.strip()
        if len(label) > 32:
            label = f"{label[:29]}..."
        axis.annotate(
            label,
            (facility_x, facility_y),
            xytext=(4, 4),
            textcoords="offset points",
            fontsize=6.5,
            color="#474b52",
            zorder=8,
        )

    scale_x = x - 620
    scale_y = y - 620
    axis.plot(
        [scale_x, scale_x + 200],
        [scale_y, scale_y],
        color="#1a1f2a",
        linewidth=2,
        zorder=8,
    )
    axis.text(
        scale_x + 100,
        scale_y + 18,
        "200 m",
        ha="center",
        va="bottom",
        fontsize=7,
        color="#1a1f2a",
    )
    axis.set_xlim(x - 700, x + 700)
    axis.set_ylim(y - 700, y + 700)
    axis.set_aspect("equal")
    axis.axis("off")
    axis.set_title(
        f"{candidate.name}\n"
        f"{_candidate_group(candidate)} | {len(gained_stop_ids)} gained stops | "
        f"{snap.offset_metres:.1f} m source snap",
        loc="left",
        fontsize=9,
        fontweight="bold",
    )
    axis.legend(
        handles=[
            Line2D([], [], marker="*", color="none", markerfacecolor="#d5563a",
                   markeredgecolor="#f4f0e7", markersize=9, label="Candidate"),
            Line2D([], [], color="#1d6380", linewidth=2, label="400 m network reach"),
            Line2D([], [], marker="^", color="none", markerfacecolor="#784f83",
                   markersize=6, label="Gained active stop"),
            Line2D([], [], marker="o", color="none", markerfacecolor="#2c6e6a",
                   markersize=6, label="Unrestricted facility"),
            Line2D([], [], marker="s", color="none", markerfacecolor="#1a1f2a",
                   markersize=6, label="Fare-paid facility"),
        ],
        loc="lower right",
        frameon=True,
        facecolor="#f4f0e7",
        edgecolor="#beb8ad",
        fontsize=6,
    )
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def _draw_summary_map(
    path: Path,
    title: str,
    points: Iterable[tuple[float, float]],
    *,
    color: str,
):
    values = tuple(points)
    fig, axis = plt.subplots(figsize=(6, 6), facecolor="#f4f0e7")
    axis.set_facecolor("#f4f0e7")
    if values:
        axis.scatter(
            [item[0] for item in values],
            [item[1] for item in values],
            s=5,
            color=color,
            alpha=0.7,
            linewidths=0,
        )
    axis.set_xlim(-79.65, -79.10)
    axis.set_ylim(43.56, 43.87)
    axis.set_aspect("equal")
    axis.axis("off")
    axis.set_title(title, loc="left", fontsize=12, fontweight="bold")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def _draw_categorical_summary_map(
    path: Path,
    title: str,
    series: Iterable[tuple[str, Iterable[tuple[float, float]], str, str]],
):
    fig, axis = plt.subplots(figsize=(6, 6), facecolor="#f4f0e7")
    axis.set_facecolor("#f4f0e7")
    plotted = False
    for label, points, color, marker in series:
        values = tuple(points)
        if values:
            plotted = True
            axis.scatter(
                [item[0] for item in values],
                [item[1] for item in values],
                s=10,
                marker=marker,
                color=color,
                alpha=0.72,
                linewidths=0,
                label=f"{label} ({len(values):,})",
            )
        else:
            axis.scatter(
                [],
                [],
                s=10,
                marker=marker,
                color=color,
                label=f"{label} (0)",
            )
    axis.set_xlim(-79.65, -79.10)
    axis.set_ylim(43.56, 43.87)
    axis.set_aspect("equal")
    axis.axis("off")
    axis.set_title(title, loc="left", fontsize=12, fontweight="bold")
    if plotted:
        axis.legend(
            loc="lower right",
            frameon=True,
            facecolor="#f4f0e7",
            edgecolor="#beb8ad",
            fontsize=7,
        )
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def _write_proof(
    staging: Path,
    *,
    candidates,
    audit_candidates,
    audit_rows,
    analysis_hash,
    audit_reason,
    gate,
    engine,
    primary,
    sensitivities,
    stop_gaps,
    snapshot_date,
    report,
):
    staging.mkdir(parents=True, exist_ok=True)
    audit_map_dir = staging / "audit-maps"
    audit_map_dir.mkdir()
    for candidate in audit_candidates:
        _draw_evidence_map(
            audit_map_dir / f"{candidate.candidate_id.replace(':', '_')}.png",
            engine,
            candidate,
            primary,
        )

    candidate_rows = []
    for candidate in candidates:
        projection = candidate_public_projection(candidate)
        candidate_rows.append(
            {
                "candidate_id": candidate.candidate_id,
                "candidate_class": candidate.candidate_class,
                "verification_kind": candidate.verification_kind or "",
                "name": candidate.name,
                "lon": candidate.lon,
                "lat": candidate.lat,
                "facility_id": candidate.facility_id or "",
                "source_stop_id": candidate.source_stop_id or "",
                "stability": candidate.stability,
                "material_gain": str(candidate.material_gain).lower(),
                "audit_status": candidate.audit_status,
                **_candidate_metric_columns(candidate),
                "projection_json": json.dumps(
                    projection,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            }
        )
    base_fields = list(candidate_rows[0]) if candidate_rows else [
        "candidate_id",
        "candidate_class",
        "verification_kind",
        "name",
    ]
    files_by_group = {
        "extend-hours.csv": ("extend_hours", None),
        "new-facility-zones.csv": ("new_facility_zone", None),
        "information-opportunities.csv": ("verify_information", None),
        "accessibility-retrofits.csv": ("retrofit_accessibility", None),
    }
    for filename, (candidate_class, _kind) in files_by_group.items():
        _write_csv(
            staging / filename,
            (
                row
                for row in candidate_rows
                if row.get("candidate_class") == candidate_class
            ),
            base_fields,
        )
    sensitivity_rows = []
    for candidate in candidates:
        sensitivity_rows.append(
            {
                "candidate_id": candidate.candidate_id,
                "scenario_id": "primary",
                "applicable": "true",
                "rank": candidate.primary_rank or "",
                "unique_trips": candidate.primary_metrics.combined_incremental.unique_trips,
                "unique_routes": candidate.primary_metrics.combined_incremental.unique_routes,
                "active_stops": candidate.primary_metrics.combined_incremental.active_stops,
                "events": candidate.primary_metrics.combined_incremental.stop_time_events,
            }
        )
        rank_by_id = {item.scenario_id: item for item in candidate.sensitivity_ranks}
        metrics_by_id = {item.scenario_id: item for item in candidate.sensitivity_metrics}
        for scenario in sensitivities:
            rank = rank_by_id[scenario.scenario_id]
            metrics = metrics_by_id.get(scenario.scenario_id)
            sensitivity_rows.append(
                {
                    "candidate_id": candidate.candidate_id,
                    "scenario_id": scenario.scenario_id,
                    "applicable": str(rank.applicable).lower(),
                    "rank": rank.published_rank,
                    "unique_trips": (
                        metrics.combined_incremental.unique_trips
                        if metrics
                        else "not applicable"
                    ),
                    "unique_routes": (
                        metrics.combined_incremental.unique_routes
                        if metrics
                        else "not applicable"
                    ),
                    "active_stops": (
                        metrics.combined_incremental.active_stops
                        if metrics
                        else "not applicable"
                    ),
                    "events": (
                        metrics.combined_incremental.stop_time_events
                        if metrics
                        else "not applicable"
                    ),
                }
            )
    _write_csv(
        staging / "scenario-sensitivity.csv",
        sensitivity_rows,
        (
            "candidate_id",
            "scenario_id",
            "applicable",
            "rank",
            "unique_trips",
            "unique_routes",
            "active_stops",
            "events",
        ),
    )
    _write_csv(
        staging / "manual-audit.csv",
        audit_rows,
        list(audit_rows[0]) if audit_rows else (
            "analysis_hash",
            "candidate_id",
            "audit_status",
        ),
    )
    stop_gap_rows = []
    for snapshot_id, gaps in stop_gaps.items():
        for stop_id, gap in sorted(gaps.items()):
            row = {
                "snapshot": snapshot_id,
                "stop_id": stop_id,
                "scenario_id": gap.scenario_id,
                "walking_distance": gap.walking_distance,
                "geographic_gap": gap.geographic_gap,
                "scheduled_time_gap": gap.scheduled_time_gap,
                "seasonal_gap": gap.seasonal_gap,
                "temporary_service_gap": gap.temporary_service_gap,
                "accessibility_gap": gap.accessibility_gap,
                "information_gap": gap.information_gap,
            }
            for category in (
                "documented",
                "open",
                "scheduled_closed",
                "seasonal_closed",
                "temporary_closed",
                "construction_closed",
                "unknown_hours",
                "open_accessible",
                "open_unknown_accessibility",
                "open_inaccessible",
            ):
                item = getattr(gap, f"nearest_{category}")
                row[f"has_{category}"] = getattr(gap, f"has_{category}")
                row[f"nearest_{category}"] = (
                    f"{item.facility_id}|{item.name}|{item.network_distance:.3f}"
                    if item
                    else ""
                )
            stop_gap_rows.append(row)
    _write_csv(
        staging / "stop-gaps.csv",
        stop_gap_rows,
        list(stop_gap_rows[0]) if stop_gap_rows else ("snapshot", "stop_id"),
    )
    _write_json(
        staging / "interventions.geojson",
        _feature_collection(
            {
                "type": "Feature",
                "id": candidate.candidate_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [candidate.lon, candidate.lat],
                },
                "properties": candidate_public_projection(candidate),
            }
            for candidate in candidates
        ),
    )
    summary = {
        "schemaVersion": 1,
        "snapshotDate": snapshot_date,
        "analysisHash": analysis_hash,
        "candidateCount": len(candidates),
        "robustCount": sum(item.stability == "robust" for item in candidates),
        "auditRequiredCount": len(audit_candidates),
        "auditValidCount": sum(item.audit_status == "valid" for item in audit_candidates),
        "gate": {
            "passed": gate.passed and not audit_reason,
            "reason": audit_reason or gate.reason,
            "countedCandidateIds": list(gate.counted_candidate_ids),
        },
    }
    _write_json(staging / "summary.json", summary)
    _write_json(staging / "build-report.json", report)
    readme = [
        "# FG03 Phase 2 dated analysis",
        "",
        f"Snapshot date: {snapshot_date}",
        "",
        "This package measures scheduled TTC service supply near documented washroom access. It does not measure passenger demand or ridership and does not identify construction-ready sites.",
        "",
        "## Product gate",
        "",
        f"- Result: {'pass' if summary['gate']['passed'] else 'fail'}",
        f"- Reason: {summary['gate']['reason']}",
        f"- Audited analysis hash: `{analysis_hash}`",
        "",
        "## Policy rules",
        "",
        "- The primary candidate universe is frozen from Tuesday 10 p.m. and 12:30 a.m., unrestricted public access, observed closures, and 400 metre walking distance.",
        "- Material gain requires at least 10 unique scheduled trips across the two late snapshots and at least 3 active stops at 400 metres.",
        "- Public and fare-paid rider-conditional access remain separate.",
        "- Scheduled closure, seasonal closure, temporary service, construction, accessibility, and missing information remain separate evidence categories.",
        "- All reaches use clipped pedestrian-network geometry. They are not Euclidean circles.",
        "",
        "## Limits",
        "",
        "- Results describe one summer weekday source snapshot plus named sensitivities.",
        "- Verification candidates describe potential gains only.",
        "- Network and source limitations remain documented in the root provenance file.",
    ]
    (staging / "README.md").write_text("\n".join(readme) + "\n", encoding="utf-8")

    points_by_group = {
        group: [
            (candidate.lon, candidate.lat)
            for candidate in candidates
            if _candidate_group(candidate) == group
        ]
        for group in (
            "extend",
            "new",
            "verify-hours",
            "verify-accessibility",
            "retrofit",
        )
    }
    _draw_summary_map(
        staging / "extend-hours-opportunities.png",
        "Scheduled-hours opportunities",
        points_by_group["extend"],
        color="#d5563a",
    )
    _draw_summary_map(
        staging / "new-facility-zones.png",
        "New-facility investigation zones",
        points_by_group["new"],
        color="#1d6380",
    )
    for snapshot_id in ("2200", "0030"):
        gap_points = {
            "geographic": [],
            "scheduled": [],
            "seasonal": [],
            "temporary": [],
            "accessibility": [],
            "information": [],
        }
        rows = _stop_rows(engine.events[snapshot_id])
        for stop_id, gap in stop_gaps[snapshot_id].items():
            point = (rows[stop_id]["lon"], rows[stop_id]["lat"])
            flags = {
                "geographic": gap.geographic_gap,
                "scheduled": gap.scheduled_time_gap,
                "seasonal": gap.seasonal_gap,
                "temporary": gap.temporary_service_gap,
                "accessibility": gap.accessibility_gap,
                "information": gap.information_gap,
            }
            for category, active in flags.items():
                if active:
                    gap_points[category].append(point)
        _draw_categorical_summary_map(
            staging / f"gap-types-{snapshot_id}.png",
            f"Gap evidence at {snapshot_id}",
            (
                ("Geographic", gap_points["geographic"], "#1d6380", "o"),
                ("Scheduled", gap_points["scheduled"], "#d5563a", "s"),
                ("Seasonal", gap_points["seasonal"], "#2c6e6a", "^"),
                ("Temporary", gap_points["temporary"], "#9c6b30", "D"),
                ("Accessibility", gap_points["accessibility"], "#784f83", "P"),
                ("Information", gap_points["information"], "#76716a", "x"),
            ),
        )
    _draw_categorical_summary_map(
        staging / "access-conditions.png",
        "Unrestricted and rider-conditional facilities",
        (
            (
                "Unrestricted",
                (
                    (item.lon, item.lat)
                    for item in engine.facilities
                    if item.access_condition == "unrestricted"
                ),
                "#2c6e6a",
                "o",
            ),
            (
                "Fare-paid",
                (
                    (item.lon, item.lat)
                    for item in engine.facilities
                    if item.access_condition == "fare_paid"
                ),
                "#1a1f2a",
                "s",
            ),
        ),
    )
    group_styles = {
        "extend": ("Extend hours", "#d5563a", "o"),
        "new": ("New facility", "#1d6380", "s"),
        "verify-hours": ("Verify hours", "#784f83", "^"),
        "verify-accessibility": ("Verify accessibility", "#2c6e6a", "P"),
        "retrofit": ("Retrofit", "#9c6b30", "D"),
    }
    _draw_categorical_summary_map(
        staging / "intervention-contact-sheet.png",
        "Five intervention ranking groups",
        (
            (
                label,
                (
                    (item.lon, item.lat)
                    for item in candidates
                    if _candidate_group(item) == group
                ),
                color,
                marker,
            )
            for group, (label, color, marker) in group_styles.items()
        ),
    )
    stability_styles = {
        "robust": ("Robust", "#1d6380", "o"),
        "mostly robust": ("Mostly robust", "#2c6e6a", "s"),
        "sensitive": ("Sensitive", "#9c6b30", "^"),
        "not prioritized": ("Not prioritized", "#76716a", "x"),
    }
    _draw_categorical_summary_map(
        staging / "sensitivity-contact-sheet.png",
        "Candidate stability across sensitivities",
        (
            (
                label,
                (
                    (item.lon, item.lat)
                    for item in candidates
                    if item.stability == stability
                ),
                color,
                marker,
            )
            for stability, (label, color, marker) in stability_styles.items()
        ),
    )


def _string_leaves(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _string_leaves(item)
    elif isinstance(value, list):
        for item in value:
            yield from _string_leaves(item)


def _keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from _keys(item)


def _validate_public(staging: Path, raw_trip_ids: set[str]):
    sizes = {}
    trip_marker = re.compile(
        r"""(?ix)
        \btrip[_.-]?(?:id|key|identifier)s?
        \s*[:=]\s*
        ["']?
        ([^"'\s,;&?\#}\]\)]+)
        """
    )
    for filename in PUBLIC_FILENAMES:
        path = staging / filename
        if not path.exists():
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"required public output {filename} was not generated",
            )
        raw = path.read_bytes()
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        if len(compressed) > PUBLIC_SIZE_LIMIT:
            raise _fail(
                "FG03_OUTPUT_TOO_LARGE",
                f"{filename} gzip size {len(compressed)} exceeds {PUBLIC_SIZE_LIMIT}; compact properties",
            )
        data = json.loads(raw)
        def is_forbidden_key(key):
            normalized = "".join(
                character
                for character in str(key).casefold()
                if character.isalnum()
            )
            return normalized.endswith(
                (
                    "tripid",
                    "tripids",
                    "tripkey",
                    "tripkeys",
                    "tripidentifier",
                    "tripidentifiers",
                )
            )

        leaked_keys = sorted(
            key for key in _keys(data) if is_forbidden_key(key)
        )
        string_leaves = set(_string_leaves(data))
        leaked_values = set(string_leaves).intersection(raw_trip_ids)
        for value in string_leaves:
            leaked_values.update(
                match.group(1)
                for match in trip_marker.finditer(value)
                if match.group(1) in raw_trip_ids
            )
        if leaked_keys or leaked_values:
            raise _fail(
                "FG03_PUBLIC_TRIP_ID_LEAK",
                f"{filename} leaks keys {leaked_keys[:3]} or values {sorted(leaked_values)[:3]}; serialize only public projections",
            )
        sizes[filename] = {
            "rawBytes": len(raw),
            "gzipBytes": len(compressed),
        }
    manifest = json.loads((staging / "manifest.json").read_text())
    if manifest.get("schemaVersion") != 1:
        raise _fail(
            "FG03_CONTRACT_INVALID",
            "manifest schemaVersion must be numeric 1",
        )
    for url in manifest["files"].values():
        if (
            not url.startswith("/data/fg03/")
            or ".." in url
            or "?" in url
            or not (staging / Path(url).name).exists()
        ):
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"manifest URL {url!r} is not a resolvable dated root-relative path",
            )
    geojson = {
        filename: json.loads((staging / filename).read_text())
        for filename in PUBLIC_FILENAMES
        if filename.endswith(".geojson")
    }

    def require_public_id(value, context):
        if (
            not isinstance(value, str)
            or not PUBLIC_PLACE_ID_PATTERN.fullmatch(value)
        ):
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"{context} {value!r} does not match the exact public place ID contract",
            )

    for filename, collection in geojson.items():
        for item in collection["features"]:
            feature_id = item.get("id")
            require_public_id(feature_id, f"{filename} feature.id")
            property_id = item.get("properties", {}).get("id")
            if property_id is not None:
                require_public_id(
                    property_id,
                    f"{filename} properties.id",
                )
                if feature_id != property_id:
                    raise _fail(
                        "FG03_CONTRACT_INVALID",
                        f"{filename} feature.id {feature_id!r} does not match properties.id {property_id!r}",
                    )
            for key in ("placeId", "facilityId"):
                value = item.get("properties", {}).get(key)
                if value is not None:
                    require_public_id(
                        value,
                        f"{filename} properties.{key}",
                    )

    facility_data = geojson["facilities.geojson"]
    intervention_data = geojson["interventions.geojson"]
    facility_ids = [item["properties"]["id"] for item in facility_data["features"]]
    intervention_ids = [
        item["properties"]["id"] for item in intervention_data["features"]
    ]
    if (
        len(facility_ids) != len(set(facility_ids))
        or len(intervention_ids) != len(set(intervention_ids))
    ):
        raise _fail(
            "FG03_CONTRACT_INVALID",
            "public place IDs are not unique within their files",
        )
    if set(facility_ids).intersection(intervention_ids):
        raise _fail(
            "FG03_CONTRACT_INVALID",
            "facility and intervention place IDs overlap",
        )
    facility_id_set = set(facility_ids)
    for item in intervention_data["features"]:
        referenced_id = item["properties"].get("facilityId")
        if referenced_id is not None and referenced_id not in facility_id_set:
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"intervention {item['id']!r} references unknown facilityId {referenced_id!r}",
            )
    for item in facility_data["features"]:
        if item["properties"]["accessCondition"] not in {"unrestricted", "fare_paid"}:
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"facility {item['id']} has an unsupported access condition",
            )

    def validate_reach_sidecar(filename, expected_place_ids):
        observed = set()
        identity_by_feature_id = {}
        for item in geojson[filename]["features"]:
            place_id = item["properties"].get("placeId")
            walk = item["properties"].get("walk")
            expected_feature_id = _public_reach_id(place_id, walk)
            if item["id"] != expected_feature_id:
                raise _fail(
                    "FG03_CONTRACT_INVALID",
                    f"{filename} reach feature {item['id']!r} does not match its placeId {place_id!r} and walk {walk!r}",
                )
            key = (place_id, walk)
            previous = identity_by_feature_id.get(item["id"])
            if previous is not None and previous != key:
                raise _fail(
                    "FG03_PUBLIC_ID_COLLISION",
                    f"{filename} reach identities {previous!r} and {key!r} publish as {item['id']!r}",
                )
            identity_by_feature_id[item["id"]] = key
            if key in observed:
                raise _fail(
                    "FG03_CONTRACT_INVALID",
                    f"{filename} repeats reach identity {key!r}",
                )
            observed.add(key)
        expected = {
            (place_id, walk)
            for place_id in expected_place_ids
            for walk in WALKS
        }
        if observed != expected:
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"{filename} advertises {len(observed)} place and walk pairs, expected {len(expected)}",
            )
        return set(identity_by_feature_id)

    facility_reach_ids = validate_reach_sidecar(
        "reach-facilities.geojson",
        set(facility_ids),
    )
    promoted_reach_ids = validate_reach_sidecar(
        "reach-promoted.geojson",
        set(intervention_ids),
    )
    overlap = facility_reach_ids.intersection(promoted_reach_ids)
    if overlap:
        raise _fail(
            "FG03_PUBLIC_ID_COLLISION",
            f"facility and intervention reach feature IDs overlap at {sorted(overlap)[0]!r}",
        )
    return sizes


def build_phase2(
    *,
    snapshot_date: str,
    proof_dir: Path,
    raw_dir: Path,
    public_dir: Path,
    boundary_path: Path,
    topology_exceptions_path: Path,
    audit_decisions_path: Path,
    generated_at: datetime,
):
    started = time.perf_counter()
    stage_started = started
    stage_seconds = {}
    proof_dir = Path(proof_dir)
    raw_dir = Path(raw_dir)
    public_dir = Path(public_dir)
    boundary_path = Path(boundary_path)
    topology_exceptions_path = Path(topology_exceptions_path)
    audit_decisions_path = Path(audit_decisions_path)
    required = (
        proof_dir / "facilities.csv",
        proof_dir / "facility-states.csv",
        proof_dir / "summary.json",
        raw_dir / "completegtfs.zip",
        raw_dir / "pedestrian-network.gpkg",
        raw_dir / "park-washrooms.csv",
        Path(boundary_path),
        Path(topology_exceptions_path),
        Path(audit_decisions_path),
    )
    for path in required:
        if not path.exists():
            raise _fail(
                "FG03_INPUT_MISSING",
                f"required input {path} is missing; restore the dated source and rerun",
            )
    phase1_summary = json.loads((proof_dir / "summary.json").read_text())
    observed_date = phase1_summary["snapshot_date"]
    if observed_date != snapshot_date:
        raise _fail(
            "FG03_SNAPSHOT_MISMATCH",
            f"expected {snapshot_date}, observed {observed_date} in {proof_dir / 'summary.json'}",
        )
    stage_seconds["validateInputs"] = time.perf_counter() - stage_started

    snapshot_day = date.fromisoformat(snapshot_date)
    boundary_json = json.loads(boundary_path.read_text())
    boundary = shape(boundary_json["features"][0]["geometry"])
    facilities, raw_facilities, schedules = _load_facilities(proof_dir)
    facility_snapshots = _load_facility_snapshots(
        proof_dir,
        facilities,
        raw_facilities,
        schedules,
    )
    stage_started = time.perf_counter()
    network_source = gpd.read_file(raw_dir / "pedestrian-network.gpkg")
    topology_exceptions, length_overrides = _network_exceptions(
        topology_exceptions_path
    )
    try:
        network = build_network(
            network_source,
            topology_exceptions=topology_exceptions,
            length_overrides=length_overrides,
        )
    except NetworkValidationError as error:
        raise Phase2BuildError(str(error)) from error
    if network.metrics.source_features == 87_105:
        observed_invariants = (
            network.metrics.source_vertices,
            network.graph.number_of_nodes(),
            network.graph.number_of_edges(),
            network.metrics.component_count,
        )
        expected_invariants = (72_590, 72_592, 95_046, 4)
        if observed_invariants != expected_invariants:
            raise _fail(
                "FG03_CONTRACT_INVALID",
                f"real base graph invariants expected {expected_invariants}, observed {observed_invariants}; review {topology_exceptions_path}",
            )
    stage_seconds["loadAndValidateNetwork"] = time.perf_counter() - stage_started

    stage_started = time.perf_counter()
    tuesday_events = _load_events(
        raw_dir / "completegtfs.zip",
        snapshot_day,
        boundary,
        windows={
            snapshot_id: (gtfs_minute, 15)
            for snapshot_id, (_weekday, _minute, gtfs_minute) in SNAPSHOTS.items()
        },
    )
    saturday_events = _load_events(
        raw_dir / "completegtfs.zip",
        date(2026, 7, 25),
        boundary,
        windows={
            snapshot_id: (gtfs_minute, 15)
            for snapshot_id, (_weekday, _minute, gtfs_minute) in SATURDAY_SNAPSHOTS.items()
        },
    )
    events_by_snapshot = {**tuesday_events, **saturday_events}
    unique_stops = {
        event.stop_id: event
        for events in events_by_snapshot.values()
        for event in events
    }
    project = Transformer.from_crs(4326, 2952, always_xy=True)
    entity_points = {
        f"facility:{facility.facility_id}": Point(
            *project.transform(facility.lon, facility.lat)
        )
        for facility in facilities
    }
    entity_points.update(
        {
            f"stop:{stop_id}": Point(*project.transform(event.lon, event.lat))
            for stop_id, event in unique_stops.items()
        }
    )
    all_snaps = batch_snap_points(network, entity_points)
    facility_snaps = {
        facility.facility_id: all_snaps[f"facility:{facility.facility_id}"]
        for facility in facilities
    }
    stop_snaps = {
        stop_id: all_snaps[f"stop:{stop_id}"]
        for stop_id in unique_stops
    }
    _validate_snap_offsets(all_snaps)
    over_limit = [
        (entity_id, snap.offset_metres)
        for entity_id, snap in all_snaps.items()
        if (
            (
                entity_id.startswith("stop:")
                and snap.offset_metres > MAX_STOP_SNAP_METRES
            )
            or (
                not entity_id.startswith("stop:")
                and snap.offset_metres > MAX_SNAP_METRES
            )
        )
    ]
    stage_seconds["loadEventsAndBatchSnap"] = time.perf_counter() - stage_started

    engine = AnalysisEngine(
        network,
        facilities,
        facility_snapshots,
        facility_snaps,
        stop_snaps,
        events_by_snapshot,
    )
    stage_started = time.perf_counter()
    candidates, primary, sensitivities, seeds_before_dedup = _build_candidates(
        engine,
        snapshot_day,
    )
    audit_required = _audit_candidates(candidates)
    analysis_hash = _analysis_hash(
        candidates,
        audit_required,
        engine,
        primary,
        snapshot_date,
        {
            "facilities": proof_dir / "facilities.csv",
            "facilityStates": proof_dir / "facility-states.csv",
            "gtfs": raw_dir / "completegtfs.zip",
            "pedestrianNetwork": raw_dir / "pedestrian-network.gpkg",
            "torontoBoundary": boundary_path,
            "topologyExceptions": topology_exceptions_path,
        },
    )
    candidates, decisions, audit_reason = _apply_audit_decisions(
        candidates,
        audit_required,
        analysis_hash,
        audit_decisions_path,
    )
    audit_required = tuple(
        next(
            candidate
            for candidate in candidates
            if candidate.candidate_id == required.candidate_id
        )
        for required in audit_required
    )
    gate = evaluate_product_gate(candidates)
    stage_seconds["analyzeCandidates"] = time.perf_counter() - stage_started

    stage_started = time.perf_counter()
    public_dir.parent.mkdir(parents=True, exist_ok=True)
    public_staging = Path(
        tempfile.mkdtemp(
            prefix=f".{public_dir.name}.staging-",
            dir=public_dir.parent,
        )
    )
    proof_destination = proof_dir / "phase2"
    proof_destination.parent.mkdir(parents=True, exist_ok=True)
    proof_staging = Path(
        tempfile.mkdtemp(
            prefix=".phase2.staging-",
            dir=proof_destination.parent,
        )
    )
    try:
        published_candidate_ids = [
            candidate.candidate_id
            for candidate in candidates
            if candidate.audit_status == "valid"
            and candidate.stability == "robust"
        ]
        public_place_ids = _public_place_id_map(
            [
                *(facility.facility_id for facility in facilities),
                *published_candidate_ids,
            ]
        )
        facility_features = _public_facilities(
            facilities,
            facility_snapshots,
            public_place_ids,
        )
        _write_json(
            public_staging / "facilities.geojson",
            _feature_collection(facility_features),
        )
        stop_gaps = {}
        stop_headlines = {}
        for snapshot_id in SNAPSHOTS:
            rows = _stop_rows(events_by_snapshot[snapshot_id])
            features, gaps = _public_stop_features(
                snapshot_id,
                rows,
                engine,
                snapshot_day,
            )
            stop_gaps[snapshot_id] = gaps
            phase1_headline = next(
                item
                for item in phase1_summary.get("snapshots", [])
                if item.get("slug") == snapshot_id
            )
            covered = sum(
                item["properties"]["coverage"]["public"]["400"]
                for item in features
            )
            stop_headlines[snapshot_id] = {
                "phase1Grouped": {
                    "unit": "grouped transit points",
                    "unrestrictedOpenAccessPointCount": phase1_headline["open_access_points"],
                    "unrestrictedOpenFacilityRecordCount": phase1_headline["open_facility_records"],
                    "farePaidOpenAccessPointCount": phase1_headline["fare_paid_open_access_points"],
                    "farePaidOpenFacilityRecordCount": phase1_headline["fare_paid_open_facility_records"],
                    "activeTransitPointCount": phase1_headline["active_transit_stops"],
                    "unrestrictedCoveredTransitPointCount": phase1_headline["covered_transit_stops"],
                    "unrestrictedCoveragePercent": phase1_headline["transit_coverage_pct"],
                },
                "phase2GtfsStops": {
                    "unit": "GTFS stops and platforms",
                    "activeStopCount": len(features),
                    "eventCount": sum(
                        item["properties"]["eventCount"] for item in features
                    ),
                    "unrestrictedCoveredStopCount": covered,
                    "uniqueTripCount": len(
                        {event.trip_id for event in events_by_snapshot[snapshot_id]}
                    ),
                },
            }
            _write_json(
                public_staging / f"stops-{snapshot_id}.geojson",
                _feature_collection(features),
            )
        intervention_features, promoted_places = _public_interventions(
            candidates,
            engine,
            snapshot_day,
            public_place_ids,
        )
        _write_json(
            public_staging / "interventions.geojson",
            _feature_collection(intervention_features),
        )
        facility_places = [
            (
                facility.facility_id,
                facility_snaps[facility.facility_id].node,
                facility_snaps[facility.facility_id].offset_metres,
                facility.access_condition,
            )
            for facility in facilities
        ]
        _write_json(
            public_staging / "reach-facilities.geojson",
            _feature_collection(
                _reach_features(
                    engine,
                    facility_places,
                    public_place_ids,
                )
            ),
        )
        _write_json(
            public_staging / "reach-promoted.geojson",
            _feature_collection(
                _reach_features(
                    engine,
                    promoted_places,
                    public_place_ids,
                )
            ),
        )
        root_url = f"/data/fg03/{snapshot_date}"
        manifest = {
            "schemaVersion": 1,
            "snapshotDate": snapshot_date,
            "generatedAt": generated_at.isoformat(),
            "defaultState": {
                "time": "2200",
                "access": "public",
                "walk": 400,
                "action": "extend",
            },
            "snapshots": list(SNAPSHOTS),
            "actions": list(PUBLIC_ACTIONS),
            "allowedValues": {
                "time": list(SNAPSHOTS),
                "access": list(ACCESS_MODES),
                "walk": list(WALKS),
                "action": list(PUBLIC_ACTIONS),
            },
            "files": {
                "facilities": f"{root_url}/facilities.geojson",
                "interventions": f"{root_url}/interventions.geojson",
                "reachFacilities": f"{root_url}/reach-facilities.geojson",
                "reachPromoted": f"{root_url}/reach-promoted.geojson",
                **{
                    f"stops{snapshot_id}": f"{root_url}/stops-{snapshot_id}.geojson"
                    for snapshot_id in SNAPSHOTS
                },
            },
            "headlines": {
                "facilities": len(facility_features),
                "interventions": len(intervention_features),
                "bySnapshot": stop_headlines,
            },
            "gate": {
                "passed": gate.passed and not audit_reason,
                "reason": audit_reason or gate.reason,
                "auditedOpportunityCount": len(gate.counted_candidate_ids),
            },
            "sources": [
                {
                    "name": "Toronto pedestrian network",
                    "url": "https://open.toronto.ca/dataset/pedestrian-network/",
                },
                {
                    "name": "TTC scheduled transit data",
                    "url": "https://www.ttc.ca/transparency-and-accountability/open-data",
                },
                {
                    "name": "Toronto public washroom sources",
                    "url": "https://open.toronto.ca/",
                },
            ],
            "limitations": [
                "Scheduled TTC activity is service supply, not passenger demand or ridership.",
                "The dated result is a summer weekday analysis.",
                "Investigation zones are not construction-ready sites.",
                "Stops and unaudited candidates do not include reach geometry.",
                "Verification actions describe potential coverage only.",
            ],
        }
        _write_json(public_staging / "manifest.json", manifest)
        raw_trip_ids = {
            event.trip_id
            for events in events_by_snapshot.values()
            for event in events
        }
        output_sizes = _validate_public(public_staging, raw_trip_ids)
        stage_seconds["serializeAndValidate"] = time.perf_counter() - stage_started

        audit_rows = _audit_rows(
            audit_required,
            analysis_hash,
            decisions,
            engine,
            primary,
        )
        elapsed = time.perf_counter() - started
        component_sizes = sorted(
            (
                len(component)
                for component in nx.connected_components(network.graph)
            ),
            reverse=True,
        )
        report = {
            "schemaVersion": 1,
            "snapshotDate": snapshot_date,
            "elapsedSeconds": elapsed,
            "stageSeconds": stage_seconds,
            "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "rows": {
                "facilities": len(facilities),
                "uniqueStops": len(unique_stops),
                "events": {
                    key: len(value)
                    for key, value in sorted(events_by_snapshot.items())
                },
            },
            "topology": {
                **asdict(network.metrics),
                "postSnapNodes": network.graph.number_of_nodes(),
                "postSnapEdges": network.graph.number_of_edges(),
                "postSnapComponentSizes": component_sizes,
                "unresolvedCrossings": 0,
                "lengthOverrides": len(length_overrides),
            },
            "snaps": {
                "facilities": _snap_diagnostics(facility_snaps),
                "stops": _snap_diagnostics(stop_snaps),
            },
            "searches": {
                "baseline": engine.baseline_searches,
                "candidate": engine.candidate_searches,
                "candidateCacheHits": engine.candidate_cache_hits,
            },
            "candidates": {
                "newZoneSeedsBeforeNodeAndEffectDedup": seeds_before_dedup,
                "totalAfterDedup": len(candidates),
                "byGroup": dict(
                    sorted(
                        Counter(_candidate_group(item) for item in candidates).items()
                    )
                ),
                "robust": sum(item.stability == "robust" for item in candidates),
            },
            "audit": {
                "analysisHash": analysis_hash,
                "required": len(audit_required),
                "valid": sum(item.audit_status == "valid" for item in audit_required),
                "excluded": sum(item.audit_status == "exclude" for item in audit_required),
                "unresolved": sum(
                    item.audit_status not in {"valid", "exclude"}
                    for item in audit_required
                ),
                "reason": audit_reason,
            },
            "gate": manifest["gate"],
            "outputSizes": output_sizes,
        }
        _write_proof(
            proof_staging,
            candidates=candidates,
            audit_candidates=audit_required,
            audit_rows=audit_rows,
            analysis_hash=analysis_hash,
            audit_reason=audit_reason,
            gate=gate,
            engine=engine,
            primary=primary,
            sensitivities=sensitivities,
            stop_gaps=stop_gaps,
            snapshot_date=snapshot_date,
            report=report,
        )
        _atomic_publish(proof_staging, proof_destination)
        _atomic_publish(public_staging, public_dir)
        return report
    finally:
        if public_staging.exists():
            shutil.rmtree(public_staging)
        if proof_staging.exists():
            shutil.rmtree(proof_staging)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-date", required=True)
    parser.add_argument("--proof-dir", type=Path, required=True)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--public-dir", type=Path, required=True)
    args = parser.parse_args()
    data_dir = Path(__file__).resolve().parent.parent
    build_phase2(
        snapshot_date=args.snapshot_date,
        proof_dir=args.proof_dir,
        raw_dir=args.raw_dir,
        public_dir=args.public_dir,
        boundary_path=data_dir / "processed" / "toronto-boundary.geojson",
        topology_exceptions_path=data_dir / "fg03" / "network-topology-exceptions.csv",
        audit_decisions_path=data_dir / "fg03" / "phase2-audit-decisions.csv",
        generated_at=datetime.now().astimezone(),
    )


if __name__ == "__main__":
    main()
