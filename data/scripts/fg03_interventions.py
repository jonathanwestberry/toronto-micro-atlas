"""Pure candidate-footprint arithmetic for Field Guide 03 interventions."""

from dataclasses import dataclass, replace
from typing import Iterable, Mapping

from fg03_analysis import (
    ActivityMetrics,
    CandidateGain,
    FacilityEvidence,
    FacilitySnapshot,
    ScenarioMetrics,
    ScenarioRank,
    SnapshotGain,
    eligible_facilities,
    has_material_gain,
    rank_candidates,
    stability_category,
)
from fg03_transit import ActiveStopEvent


@dataclass(frozen=True, slots=True)
class SnapshotEvents:
    snapshot_id: str
    events: tuple[ActiveStopEvent, ...]


@dataclass(frozen=True, slots=True)
class SnapshotStops:
    snapshot_id: str
    stop_ids: frozenset[str]


@dataclass(frozen=True, slots=True)
class CoverageFootprint:
    source_id: str
    node_id: str
    stops_by_snapshot: Mapping[str, frozenset[str]]

    def stops_for(self, snapshot_id: str) -> frozenset[str]:
        return self.stops_by_snapshot.get(snapshot_id, frozenset())


@dataclass(frozen=True, slots=True)
class ScenarioInputs:
    scenario: Scenario
    snapshot_events: tuple[SnapshotEvents, ...]
    baseline_covered: tuple[SnapshotStops, ...]

    def __post_init__(self) -> None:
        event_ids = {item.snapshot_id for item in self.snapshot_events}
        baseline_ids = {item.snapshot_id for item in self.baseline_covered}
        missing = set(self.scenario.snapshot_ids).difference(event_ids)
        if missing:
            raise ValueError(f"Scenario is missing event snapshots: {sorted(missing)}")
        if missing := set(self.scenario.snapshot_ids).difference(baseline_ids):
            raise ValueError(f"Scenario is missing baseline snapshots: {sorted(missing)}")


@dataclass(frozen=True, slots=True)
class NewFacilitySeed:
    representative_stop_id: str
    name: str
    lon: float
    lat: float
    node_id: str
    footprint: CoverageFootprint


def _activity(events: Iterable[ActiveStopEvent]) -> ActivityMetrics:
    items = tuple(events)
    return ActivityMetrics(
        unique_trips=len({item.trip_id for item in items}),
        unique_routes=len({item.route_id for item in items}),
        active_stops=len({item.stop_id for item in items}),
        stop_time_events=len(items),
    )


def _combined_activity(events: Iterable[tuple[str, ActiveStopEvent]]) -> ActivityMetrics:
    items = tuple(events)
    return ActivityMetrics(
        unique_trips=len({(snapshot_id, event.trip_id) for snapshot_id, event in items}),
        unique_routes=len({event.route_id for _snapshot_id, event in items}),
        active_stops=len({event.stop_id for _snapshot_id, event in items}),
        stop_time_events=len(items),
    )


def _scenario_metrics(
    inputs: ScenarioInputs,
    footprint: CoverageFootprint,
    *,
    active_snapshot_ids: frozenset[str] | None = None,
) -> ScenarioMetrics:
    events_by_snapshot = {item.snapshot_id: item.events for item in inputs.snapshot_events}
    baseline_by_snapshot = {item.snapshot_id: item.stop_ids for item in inputs.baseline_covered}
    gains: list[SnapshotGain] = []
    incremental_events: list[tuple[str, ActiveStopEvent]] = []
    total_events: list[tuple[str, ActiveStopEvent]] = []
    effect_keys: set[tuple[str, str]] = set()
    positive_snapshots = 0
    for snapshot_id in inputs.scenario.snapshot_ids:
        enabled = active_snapshot_ids is None or snapshot_id in active_snapshot_ids
        stops = footprint.stops_for(snapshot_id) if enabled else frozenset()
        all_events = events_by_snapshot[snapshot_id]
        total = tuple(event for event in all_events if event.stop_id in stops)
        incremental_stops = stops.difference(baseline_by_snapshot[snapshot_id])
        incremental = tuple(event for event in all_events if event.stop_id in incremental_stops)
        if {event.trip_id for event in incremental}:
            positive_snapshots += 1
        gains.append(SnapshotGain(snapshot_id, _activity(incremental), _activity(total)))
        incremental_events.extend((snapshot_id, event) for event in incremental)
        total_events.extend((snapshot_id, event) for event in total)
        effect_keys.update((snapshot_id, event.trip_id) for event in incremental)
    return ScenarioMetrics(
        scenario_id=inputs.scenario.scenario_id,
        snapshot_gains=tuple(gains),
        combined_incremental=_combined_activity(incremental_events),
        combined_total=_combined_activity(total_events),
        positive_late_snapshots=positive_snapshots,
        _effect_trip_keys=frozenset(effect_keys),
    )


def _base_candidate(
    *,
    candidate_id: str,
    candidate_class: str,
    verification_kind: str | None,
    name: str,
    lon: float,
    lat: float,
    source_stop_id: str | None,
    facility: FacilityEvidence | None,
    gain_label: str,
    metrics: ScenarioMetrics,
    walking_distance: int,
) -> CandidateGain:
    return CandidateGain(
        candidate_id=candidate_id,
        candidate_class=candidate_class,
        verification_kind=verification_kind,
        name=name,
        lon=lon,
        lat=lat,
        source_stop_id=source_stop_id,
        facility_id=facility.facility_id if facility else None,
        facility=facility,
        gain_label=gain_label,
        primary_metrics=metrics,
        sensitivity_metrics=(),
        primary_rank=None,
        sensitivity_ranks=(),
        stability="not prioritized",
        material_gain=has_material_gain(metrics, walking_distance=walking_distance),
        audit_status="source review",
        source_error=False,
        duplicate_candidate=False,
        misclassified_access=False,
        review_flags=(),
    )


def _finish_primary(candidates: Iterable[CandidateGain]) -> tuple[CandidateGain, ...]:
    items = tuple(candidates)
    if not items:
        return ()
    scenario_id = items[0].primary_metrics.scenario_id
    ranked = rank_candidates(items, scenario_id=scenario_id)
    return tuple(
        replace(
            item,
            stability=stability_category((ScenarioRank(scenario_id, True, item.primary_rank),)),
        )
        for item in ranked
    )


def _snapshots_by_facility(
    snapshots: Iterable[FacilitySnapshot],
) -> dict[str, tuple[FacilitySnapshot, ...]]:
    grouped: dict[str, list[FacilitySnapshot]] = {}
    for snapshot in snapshots:
        grouped.setdefault(snapshot.facility_id, []).append(snapshot)
    return {key: tuple(value) for key, value in grouped.items()}


def simulate_hours_extensions(
    inputs: ScenarioInputs,
    *,
    facilities: Iterable[FacilityEvidence],
    snapshots: Iterable[FacilitySnapshot],
    footprints: Mapping[str, CoverageFootprint],
) -> tuple[CandidateGain, ...]:
    """Model only facilities unavailable solely through their weekly schedule."""
    candidates = []
    states_by_facility = _snapshots_by_facility(snapshots)
    for facility in eligible_facilities(facilities, access_mode=inputs.scenario.access_mode):
        states = states_by_facility.get(facility.facility_id, ())
        if not states or any(state.observed_state not in {"open", "scheduled_closed"} for state in states):
            continue
        active = frozenset(
            state.snapshot_id for state in states if state.observed_state == "scheduled_closed"
        )
        if not active or facility.facility_id not in footprints:
            continue
        metrics = _scenario_metrics(inputs, footprints[facility.facility_id], active_snapshot_ids=active)
        candidates.append(
            _base_candidate(
                candidate_id=f"extend-hours:{facility.facility_id}",
                candidate_class="extend_hours",
                verification_kind=None,
                name=facility.name,
                lon=facility.lon,
                lat=facility.lat,
                source_stop_id=None,
                facility=facility,
                gain_label="incremental",
                metrics=metrics,
                walking_distance=inputs.scenario.walking_distance,
            )
        )
    return _finish_primary(candidates)


def simulate_new_facility_zones(
    inputs: ScenarioInputs, *, seeds: Iterable[NewFacilitySeed]
) -> tuple[CandidateGain, ...]:
    """Create deterministic, effect-deduplicated investigation-zone candidates."""
    collapsed: dict[str, NewFacilitySeed] = {}
    for seed in seeds:
        prior = collapsed.get(seed.node_id)
        if prior is None or seed.representative_stop_id < prior.representative_stop_id:
            collapsed[seed.node_id] = seed
    candidates = []
    for seed in collapsed.values():
        metrics = _scenario_metrics(inputs, seed.footprint)
        if not metrics._effect_trip_keys:
            raise ValueError(f"New-facility seed {seed.representative_stop_id} has an empty effect")
        candidates.append(
            _base_candidate(
                candidate_id=f"new-facility-zone:{seed.representative_stop_id}",
                candidate_class="new_facility_zone",
                verification_kind=None,
                name=seed.name,
                lon=seed.lon,
                lat=seed.lat,
                source_stop_id=seed.representative_stop_id,
                facility=None,
                gain_label="incremental",
                metrics=metrics,
                walking_distance=inputs.scenario.walking_distance,
            )
        )
    ordered = sorted(
        candidates,
        key=lambda item: (
            -item.primary_metrics.combined_incremental.unique_trips,
            -item.primary_metrics.combined_incremental.unique_routes,
            -item.primary_metrics.combined_incremental.active_stops,
            item.source_stop_id or "",
            item.candidate_id,
        ),
    )
    kept: list[CandidateGain] = []
    for candidate in ordered:
        later = candidate.primary_metrics._effect_trip_keys
        if any(len(later.intersection(item.primary_metrics._effect_trip_keys)) / len(later) >= 0.8 for item in kept):
            continue
        kept.append(candidate)
    return _finish_primary(kept)


def simulate_information_verification(
    inputs: ScenarioInputs,
    *,
    facilities: Iterable[FacilityEvidence],
    snapshots: Iterable[FacilitySnapshot],
    footprints: Mapping[str, CoverageFootprint],
) -> tuple[CandidateGain, ...]:
    """Model potential gains from independently verifying hours or accessibility."""
    states_by_facility = _snapshots_by_facility(snapshots)
    hours_candidates: list[CandidateGain] = []
    accessibility_candidates: list[CandidateGain] = []
    for facility in eligible_facilities(facilities, access_mode=inputs.scenario.access_mode):
        if facility.facility_id not in footprints:
            continue
        states = states_by_facility.get(facility.facility_id, ())
        unknown_hours = frozenset(
            state.snapshot_id for state in states if state.observed_state == "unknown_hours"
        )
        if unknown_hours:
            hours_candidates.append(
                _base_candidate(
                    candidate_id=f"verify-hours:{facility.facility_id}",
                    candidate_class="verify_information",
                    verification_kind="hours",
                    name=facility.name,
                    lon=facility.lon,
                    lat=facility.lat,
                    source_stop_id=None,
                    facility=facility,
                    gain_label="potential_if_verified",
                    metrics=_scenario_metrics(inputs, footprints[facility.facility_id], active_snapshot_ids=unknown_hours),
                    walking_distance=inputs.scenario.walking_distance,
                )
            )
        open_unknown_access = frozenset(
            state.snapshot_id for state in states if state.observed_state == "open"
        )
        if facility.accessibility == "unknown" and open_unknown_access:
            accessibility_candidates.append(
                _base_candidate(
                    candidate_id=f"verify-accessibility:{facility.facility_id}",
                    candidate_class="verify_information",
                    verification_kind="accessibility",
                    name=facility.name,
                    lon=facility.lon,
                    lat=facility.lat,
                    source_stop_id=None,
                    facility=facility,
                    gain_label="potential_if_verified",
                    metrics=_scenario_metrics(inputs, footprints[facility.facility_id], active_snapshot_ids=open_unknown_access),
                    walking_distance=inputs.scenario.walking_distance,
                )
            )
    return tuple(sorted(_finish_primary(hours_candidates) + _finish_primary(accessibility_candidates), key=lambda item: item.candidate_id))


def simulate_accessibility_retrofits(
    inputs: ScenarioInputs,
    *,
    facilities: Iterable[FacilityEvidence],
    snapshots: Iterable[FacilitySnapshot],
    footprints: Mapping[str, CoverageFootprint],
) -> tuple[CandidateGain, ...]:
    """Model only confirmed physical barriers while facilities are already open."""
    states_by_facility = _snapshots_by_facility(snapshots)
    candidates = []
    for facility in eligible_facilities(facilities, access_mode=inputs.scenario.access_mode):
        if facility.accessibility != "inaccessible" or facility.facility_id not in footprints:
            continue
        states = states_by_facility.get(facility.facility_id, ())
        open_snapshots = frozenset(
            state.snapshot_id for state in states if state.observed_state == "open"
        )
        if not open_snapshots:
            continue
        candidates.append(
            _base_candidate(
                candidate_id=f"retrofit-accessibility:{facility.facility_id}",
                candidate_class="retrofit_accessibility",
                verification_kind=None,
                name=facility.name,
                lon=facility.lon,
                lat=facility.lat,
                source_stop_id=None,
                facility=facility,
                gain_label="incremental",
                metrics=_scenario_metrics(inputs, footprints[facility.facility_id], active_snapshot_ids=open_snapshots),
                walking_distance=inputs.scenario.walking_distance,
            )
        )
    return _finish_primary(candidates)
