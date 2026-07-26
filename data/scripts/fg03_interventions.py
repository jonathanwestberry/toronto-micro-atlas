"""Pure candidate-footprint arithmetic for Field Guide 03 interventions."""

from dataclasses import dataclass, replace
from datetime import date
from typing import Iterable, Mapping

from fg03_analysis import (
    ActivityMetrics,
    CandidateGain,
    FacilityEvidence,
    FacilitySnapshot,
    Scenario,
    ScenarioMetrics,
    ScenarioRank,
    SnapshotGain,
    effective_facility_state,
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
    sensitivity_metrics: tuple[ScenarioMetrics, ...] = (),
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
        sensitivity_metrics=sensitivity_metrics,
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


def _scenario_is_applicable(candidate_class: str, scenario: Scenario) -> bool:
    return not (
        scenario.information_mode == "optimistic_information"
        and candidate_class in {"extend_hours", "verify_information"}
    )


def _finish_runs(
    candidates: Iterable[CandidateGain],
    sensitivity_inputs: tuple[ScenarioInputs, ...],
) -> tuple[CandidateGain, ...]:
    items = tuple(candidates)
    if not items:
        return ()
    primary_scenario_id = items[0].primary_metrics.scenario_id
    rank_scenarios = tuple(inputs.scenario for inputs in sensitivity_inputs)
    ranked = tuple(
        replace(
            item,
            sensitivity_ranks=tuple(
                ScenarioRank(
                    scenario.scenario_id,
                    _scenario_is_applicable(item.candidate_class, scenario),
                    None,
                )
                for scenario in rank_scenarios
            ),
        )
        for item in items
    )
    ranked = rank_candidates(ranked, scenario_id=primary_scenario_id)
    for scenario in rank_scenarios:
        if not _scenario_is_applicable(ranked[0].candidate_class, scenario):
            continue
        ranked = rank_candidates(ranked, scenario_id=scenario.scenario_id)
    finished = tuple(
        replace(
            item,
            stability=stability_category(
                (
                    ScenarioRank(primary_scenario_id, True, item.primary_rank),
                    *item.sensitivity_ranks,
                )
            ),
        )
        for item in ranked
    )
    return tuple(
        sorted(
            finished,
            key=lambda item: (
                item.primary_rank if item.primary_rank is not None else float("inf"),
                item.candidate_id,
            ),
        )
    )


def _validated_sensitivities(
    primary_inputs: ScenarioInputs,
    sensitivity_inputs: Iterable[ScenarioInputs],
) -> tuple[ScenarioInputs, ...]:
    items = tuple(sensitivity_inputs)
    scenario_ids = [
        primary_inputs.scenario.scenario_id,
        *(item.scenario.scenario_id for item in items),
    ]
    if len(scenario_ids) != len(set(scenario_ids)):
        raise ValueError("Scenario IDs must be unique across primary and sensitivities")
    return items


def _sensitivity_footprint(
    source_id: str,
    inputs: ScenarioInputs,
    sensitivity_footprints: Mapping[str, Mapping[str, CoverageFootprint]],
) -> CoverageFootprint:
    scenario_id = inputs.scenario.scenario_id
    if scenario_id not in sensitivity_footprints:
        raise ValueError(f"Missing footprint set for sensitivity {scenario_id}")
    footprints = sensitivity_footprints[scenario_id]
    if source_id not in footprints:
        raise ValueError(
            f"Missing footprint for {source_id} in sensitivity {scenario_id}"
        )
    return footprints[source_id]


def _snapshots_by_facility(
    snapshots: Iterable[FacilitySnapshot],
) -> dict[str, tuple[FacilitySnapshot, ...]]:
    grouped: dict[str, list[FacilitySnapshot]] = {}
    for snapshot in snapshots:
        grouped.setdefault(snapshot.facility_id, []).append(snapshot)
    return {key: tuple(value) for key, value in grouped.items()}


def _active_snapshot_ids(
    states: Iterable[FacilitySnapshot],
    scenario: Scenario,
    *,
    accepted_states: frozenset[str],
) -> frozenset[str]:
    state_by_snapshot = {state.snapshot_id: state for state in states}
    return frozenset(
        snapshot_id
        for snapshot_id in scenario.snapshot_ids
        if snapshot_id in state_by_snapshot
        and effective_facility_state(state_by_snapshot[snapshot_id], scenario)
        in accepted_states
    )


def simulate_hours_extensions(
    inputs: ScenarioInputs,
    *,
    sensitivity_inputs: Iterable[ScenarioInputs] = (),
    facilities: Iterable[FacilityEvidence],
    snapshots: Iterable[FacilitySnapshot],
    footprints: Mapping[str, CoverageFootprint],
    sensitivity_footprints: Mapping[
        str, Mapping[str, CoverageFootprint]
    ] | None = None,
) -> tuple[CandidateGain, ...]:
    """Model only facilities unavailable solely through their weekly schedule."""
    sensitivities = _validated_sensitivities(inputs, sensitivity_inputs)
    sensitivity_footprints = sensitivity_footprints or {}
    candidates = []
    states_by_facility = _snapshots_by_facility(snapshots)
    for facility in eligible_facilities(facilities, access_mode=inputs.scenario.access_mode):
        states = states_by_facility.get(facility.facility_id, ())
        active = _active_snapshot_ids(
            states,
            inputs.scenario,
            accepted_states=frozenset({"scheduled_closed"}),
        )
        if not active or facility.facility_id not in footprints:
            continue
        metrics = _scenario_metrics(
            inputs,
            footprints[facility.facility_id],
            active_snapshot_ids=active,
        )
        sensitivity_metrics = []
        for sensitivity in sensitivities:
            if not _scenario_is_applicable("extend_hours", sensitivity.scenario):
                continue
            sensitivity_active = _active_snapshot_ids(
                states,
                sensitivity.scenario,
                accepted_states=frozenset({"scheduled_closed"}),
            )
            sensitivity_metrics.append(
                _scenario_metrics(
                    sensitivity,
                    _sensitivity_footprint(
                        facility.facility_id,
                        sensitivity,
                        sensitivity_footprints,
                    ),
                    active_snapshot_ids=sensitivity_active,
                )
            )
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
                sensitivity_metrics=tuple(sensitivity_metrics),
            )
        )
    return _finish_runs(candidates, sensitivities)


def _validate_new_zone_primary(scenario: Scenario) -> None:
    is_primary = (
        scenario.service_date == date(2026, 7, 21)
        and scenario.access_mode == "public"
        and scenario.walking_distance == 400
        and scenario.closure_mode == "observed"
        and scenario.information_mode == "unknown_unavailable"
        and len(scenario.snapshot_ids) == 2
    )
    if not is_primary:
        raise ValueError(
            "New-zone universe requires the primary Tuesday public observed "
            "400 metre two-snapshot scenario"
        )


def simulate_new_facility_zones(
    inputs: ScenarioInputs,
    *,
    sensitivity_inputs: Iterable[ScenarioInputs] = (),
    seeds: Iterable[NewFacilitySeed],
    sensitivity_seeds: Mapping[str, Iterable[NewFacilitySeed]] | None = None,
) -> tuple[CandidateGain, ...]:
    """Create deterministic, effect-deduplicated investigation-zone candidates."""
    _validate_new_zone_primary(inputs.scenario)
    sensitivities = _validated_sensitivities(inputs, sensitivity_inputs)
    sensitivity_seeds = sensitivity_seeds or {}
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
        if any(
            len(later.intersection(item.primary_metrics._effect_trip_keys))
            / len(later)
            >= 0.8
            for item in kept
        ):
            continue
        kept.append(candidate)
    sensitivity_seeds_by_scenario: dict[str, dict[str, NewFacilitySeed]] = {}
    for sensitivity in sensitivities:
        scenario_id = sensitivity.scenario.scenario_id
        if scenario_id not in sensitivity_seeds:
            raise ValueError(f"Missing new-zone seeds for sensitivity {scenario_id}")
        seeds_by_id: dict[str, NewFacilitySeed] = {}
        for seed in sensitivity_seeds[scenario_id]:
            if seed.representative_stop_id in seeds_by_id:
                raise ValueError(
                    f"Duplicate new-zone seed {seed.representative_stop_id} "
                    f"for sensitivity {scenario_id}"
                )
            seeds_by_id[seed.representative_stop_id] = seed
        sensitivity_seeds_by_scenario[scenario_id] = seeds_by_id
    enriched = []
    for candidate in kept:
        sensitivity_metrics = []
        for sensitivity in sensitivities:
            scenario_id = sensitivity.scenario.scenario_id
            seeds_by_id = sensitivity_seeds_by_scenario[scenario_id]
            representative_stop_id = candidate.source_stop_id
            if representative_stop_id not in seeds_by_id:
                raise ValueError(
                    f"Missing frozen new-zone seed {representative_stop_id} "
                    f"for sensitivity {scenario_id}"
                )
            sensitivity_metrics.append(
                _scenario_metrics(
                    sensitivity,
                    seeds_by_id[representative_stop_id].footprint,
                )
            )
        enriched.append(
            replace(candidate, sensitivity_metrics=tuple(sensitivity_metrics))
        )
    return _finish_runs(enriched, sensitivities)


def simulate_information_verification(
    inputs: ScenarioInputs,
    *,
    sensitivity_inputs: Iterable[ScenarioInputs] = (),
    facilities: Iterable[FacilityEvidence],
    snapshots: Iterable[FacilitySnapshot],
    footprints: Mapping[str, CoverageFootprint],
    sensitivity_footprints: Mapping[
        str, Mapping[str, CoverageFootprint]
    ] | None = None,
) -> tuple[CandidateGain, ...]:
    """Model potential gains from independently verifying hours or accessibility."""
    sensitivities = _validated_sensitivities(inputs, sensitivity_inputs)
    sensitivity_footprints = sensitivity_footprints or {}
    states_by_facility = _snapshots_by_facility(snapshots)
    hours_candidates: list[CandidateGain] = []
    accessibility_candidates: list[CandidateGain] = []
    for facility in eligible_facilities(facilities, access_mode=inputs.scenario.access_mode):
        if facility.facility_id not in footprints:
            continue
        states = states_by_facility.get(facility.facility_id, ())
        unknown_hours = _active_snapshot_ids(
            states,
            inputs.scenario,
            accepted_states=frozenset({"unknown_hours"}),
        )
        if unknown_hours:
            sensitivity_metrics = []
            for sensitivity in sensitivities:
                if not _scenario_is_applicable(
                    "verify_information", sensitivity.scenario
                ):
                    continue
                sensitivity_metrics.append(
                    _scenario_metrics(
                        sensitivity,
                        _sensitivity_footprint(
                            facility.facility_id,
                            sensitivity,
                            sensitivity_footprints,
                        ),
                        active_snapshot_ids=_active_snapshot_ids(
                            states,
                            sensitivity.scenario,
                            accepted_states=frozenset({"unknown_hours"}),
                        ),
                    )
                )
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
                    metrics=_scenario_metrics(
                        inputs,
                        footprints[facility.facility_id],
                        active_snapshot_ids=unknown_hours,
                    ),
                    walking_distance=inputs.scenario.walking_distance,
                    sensitivity_metrics=tuple(sensitivity_metrics),
                )
            )
        open_unknown_access = _active_snapshot_ids(
            states,
            inputs.scenario,
            accepted_states=frozenset({"open"}),
        )
        if facility.accessibility == "unknown" and open_unknown_access:
            sensitivity_metrics = []
            for sensitivity in sensitivities:
                if not _scenario_is_applicable(
                    "verify_information", sensitivity.scenario
                ):
                    continue
                sensitivity_metrics.append(
                    _scenario_metrics(
                        sensitivity,
                        _sensitivity_footprint(
                            facility.facility_id,
                            sensitivity,
                            sensitivity_footprints,
                        ),
                        active_snapshot_ids=_active_snapshot_ids(
                            states,
                            sensitivity.scenario,
                            accepted_states=frozenset({"open"}),
                        ),
                    )
                )
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
                    metrics=_scenario_metrics(
                        inputs,
                        footprints[facility.facility_id],
                        active_snapshot_ids=open_unknown_access,
                    ),
                    walking_distance=inputs.scenario.walking_distance,
                    sensitivity_metrics=tuple(sensitivity_metrics),
                )
            )
    return tuple(
        sorted(
            _finish_runs(hours_candidates, sensitivities)
            + _finish_runs(accessibility_candidates, sensitivities),
            key=lambda item: item.candidate_id,
        )
    )


def simulate_accessibility_retrofits(
    inputs: ScenarioInputs,
    *,
    sensitivity_inputs: Iterable[ScenarioInputs] = (),
    facilities: Iterable[FacilityEvidence],
    snapshots: Iterable[FacilitySnapshot],
    footprints: Mapping[str, CoverageFootprint],
    sensitivity_footprints: Mapping[
        str, Mapping[str, CoverageFootprint]
    ] | None = None,
) -> tuple[CandidateGain, ...]:
    """Model only confirmed physical barriers while facilities are already open."""
    sensitivities = _validated_sensitivities(inputs, sensitivity_inputs)
    sensitivity_footprints = sensitivity_footprints or {}
    states_by_facility = _snapshots_by_facility(snapshots)
    candidates = []
    for facility in eligible_facilities(facilities, access_mode=inputs.scenario.access_mode):
        if facility.accessibility != "inaccessible" or facility.facility_id not in footprints:
            continue
        states = states_by_facility.get(facility.facility_id, ())
        open_snapshots = _active_snapshot_ids(
            states,
            inputs.scenario,
            accepted_states=frozenset({"open"}),
        )
        if not open_snapshots:
            continue
        sensitivity_metrics = []
        for sensitivity in sensitivities:
            sensitivity_metrics.append(
                _scenario_metrics(
                    sensitivity,
                    _sensitivity_footprint(
                        facility.facility_id,
                        sensitivity,
                        sensitivity_footprints,
                    ),
                    active_snapshot_ids=_active_snapshot_ids(
                        states,
                        sensitivity.scenario,
                        accepted_states=frozenset({"open", "potential_open"}),
                    ),
                )
            )
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
                metrics=_scenario_metrics(
                    inputs,
                    footprints[facility.facility_id],
                    active_snapshot_ids=open_snapshots,
                ),
                walking_distance=inputs.scenario.walking_distance,
                sensitivity_metrics=tuple(sensitivity_metrics),
            )
        )
    return _finish_runs(candidates, sensitivities)
