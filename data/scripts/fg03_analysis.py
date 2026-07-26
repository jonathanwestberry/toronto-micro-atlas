"""Pure Field Guide 03 gap, ranking, and product-gate rules."""

from dataclasses import dataclass, replace
from datetime import date
from typing import Iterable, Mapping

from fg03_transit import ActivityMetrics


ACCESS_MODES = frozenset({"public", "rider_conditional"})
CLOSURE_MODES = frozenset({"observed", "normal_operations"})
INFORMATION_MODES = frozenset({"unknown_unavailable", "optimistic_information"})
CANDIDATE_CLASSES = frozenset(
    {"extend_hours", "new_facility_zone", "verify_information", "retrofit_accessibility"}
)


@dataclass(frozen=True, slots=True)
class Scenario:
    scenario_id: str
    service_date: date
    snapshot_ids: tuple[str, ...]
    access_mode: str
    walking_distance: int
    closure_mode: str
    information_mode: str

    def __post_init__(self) -> None:
        if self.access_mode not in ACCESS_MODES:
            raise ValueError(f"Unsupported access mode: {self.access_mode}")
        if self.closure_mode not in CLOSURE_MODES:
            raise ValueError(f"Unsupported closure mode: {self.closure_mode}")
        if self.information_mode not in INFORMATION_MODES:
            raise ValueError(f"Unsupported information mode: {self.information_mode}")
        if self.walking_distance not in {300, 400, 500}:
            raise ValueError(f"Unsupported walking distance: {self.walking_distance}")


@dataclass(frozen=True, slots=True)
class FacilityEvidence:
    facility_id: str
    name: str
    source: str
    address: str
    lon: float
    lat: float
    hours: str
    access_condition: str
    closure_category: str
    accessibility: str
    partial_service: bool
    source_url: str
    notes: str

    def __post_init__(self) -> None:
        if self.access_condition not in {"unrestricted", "fare_paid"}:
            raise ValueError(f"Unsupported access condition: {self.access_condition}")
        if self.closure_category not in {"none", "seasonal", "temporary", "construction"}:
            raise ValueError(f"Unsupported closure category: {self.closure_category}")
        if self.accessibility not in {"accessible", "inaccessible", "unknown"}:
            raise ValueError(f"Unsupported accessibility: {self.accessibility}")


@dataclass(frozen=True, slots=True)
class FacilitySnapshot:
    facility_id: str
    snapshot_id: str
    scheduled_state: str
    observed_state: str

    def __post_init__(self) -> None:
        if self.scheduled_state not in {"open", "closed", "unknown"}:
            raise ValueError(f"Unsupported scheduled state: {self.scheduled_state}")
        if self.observed_state not in {
            "open",
            "scheduled_closed",
            "seasonal_closed",
            "temporary_closed",
            "construction_closed",
            "unknown_hours",
            "potential_open",
        }:
            raise ValueError(f"Unsupported observed state: {self.observed_state}")


def effective_facility_state(snapshot: FacilitySnapshot, scenario: Scenario) -> str:
    """Resolve a persisted observed and scheduled state under one scenario."""
    state = snapshot.observed_state
    if scenario.closure_mode == "normal_operations" and state == "temporary_closed":
        state = {
            "open": "open",
            "closed": "scheduled_closed",
            "unknown": "unknown_hours",
        }[snapshot.scheduled_state]
    if scenario.information_mode == "optimistic_information" and state == "unknown_hours":
        return "potential_open"
    return state


@dataclass(frozen=True, slots=True)
class NearestFacility:
    facility_id: str
    name: str
    network_distance: float


_PRESENCE_NAMES = (
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
)


@dataclass(frozen=True, slots=True)
class GapEvidence:
    stop_id: str
    scenario_id: str
    walking_distance: int
    has_documented: bool
    nearest_documented: NearestFacility | None
    has_open: bool
    nearest_open: NearestFacility | None
    has_scheduled_closed: bool
    nearest_scheduled_closed: NearestFacility | None
    has_seasonal_closed: bool
    nearest_seasonal_closed: NearestFacility | None
    has_temporary_closed: bool
    nearest_temporary_closed: NearestFacility | None
    has_construction_closed: bool
    nearest_construction_closed: NearestFacility | None
    has_unknown_hours: bool
    nearest_unknown_hours: NearestFacility | None
    has_open_accessible: bool
    nearest_open_accessible: NearestFacility | None
    has_open_unknown_accessibility: bool
    nearest_open_unknown_accessibility: NearestFacility | None
    has_open_inaccessible: bool
    nearest_open_inaccessible: NearestFacility | None
    geographic_gap: bool
    scheduled_time_gap: bool
    seasonal_gap: bool
    temporary_service_gap: bool
    accessibility_gap: bool
    information_gap: bool


@dataclass(frozen=True, slots=True)
class SnapshotGain:
    snapshot_id: str
    incremental: ActivityMetrics
    total_catchment: ActivityMetrics


@dataclass(frozen=True, slots=True)
class ScenarioMetrics:
    scenario_id: str
    snapshot_gains: tuple[SnapshotGain, ...]
    combined_incremental: ActivityMetrics
    combined_total: ActivityMetrics
    positive_late_snapshots: int
    _effect_trip_keys: frozenset[tuple[str, str]]


@dataclass(frozen=True, slots=True)
class ScenarioRank:
    scenario_id: str
    applicable: bool
    rank: int | None

    def __post_init__(self) -> None:
        if not self.applicable and self.rank is not None:
            raise ValueError("A non-applicable scenario cannot have a rank")

    @property
    def published_rank(self) -> int | str:
        return self.rank if self.applicable else "not applicable"


@dataclass(frozen=True, slots=True)
class CandidateGain:
    candidate_id: str
    candidate_class: str
    verification_kind: str | None
    name: str
    lon: float
    lat: float
    source_stop_id: str | None
    facility_id: str | None
    facility: FacilityEvidence | None
    gain_label: str
    primary_metrics: ScenarioMetrics
    sensitivity_metrics: tuple[ScenarioMetrics, ...]
    primary_rank: int | None
    sensitivity_ranks: tuple[ScenarioRank, ...]
    stability: str
    material_gain: bool
    audit_status: str
    source_error: bool
    duplicate_candidate: bool
    misclassified_access: bool
    review_flags: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.candidate_class not in CANDIDATE_CLASSES:
            raise ValueError(f"Unsupported candidate class: {self.candidate_class}")
        if self.verification_kind not in {None, "hours", "accessibility"}:
            raise ValueError(f"Unsupported verification kind: {self.verification_kind}")
        if self.candidate_class == "verify_information":
            if self.verification_kind is None:
                raise ValueError("Verification candidates require a verification kind")
        elif self.verification_kind is not None:
            raise ValueError(
                f"Candidate class {self.candidate_class} cannot have a verification kind"
            )
        if self.gain_label not in {"incremental", "potential_if_verified"}:
            raise ValueError(f"Unsupported gain label: {self.gain_label}")
        if self.stability not in {
            "robust",
            "mostly robust",
            "sensitive",
            "not prioritized",
        }:
            raise ValueError(f"Unsupported stability: {self.stability}")
        if self.audit_status not in {"valid", "merge review", "source review", "exclude"}:
            raise ValueError(f"Unsupported audit status: {self.audit_status}")


@dataclass(frozen=True, slots=True)
class ProductGateResult:
    passed: bool
    reason: str
    counted_candidate_ids: tuple[str, ...]


def eligible_facilities(
    facilities: Iterable[FacilityEvidence], *, access_mode: str
) -> tuple[FacilityEvidence, ...]:
    """Return facilities permitted by a public or rider-conditional scenario."""
    if access_mode not in ACCESS_MODES:
        raise ValueError(f"Unsupported access mode: {access_mode}")
    if access_mode == "public":
        return tuple(item for item in facilities if item.access_condition == "unrestricted")
    return tuple(facilities)


def classify_gap(
    *, stop_id: str, scenario: Scenario, nearest: Mapping[str, NearestFacility | None]
) -> GapEvidence:
    """Classify coexisting gap flags from already-filtered nearest evidence."""
    unexpected = set(nearest).difference(_PRESENCE_NAMES)
    if unexpected:
        raise ValueError(f"Unknown nearest-evidence keys: {sorted(unexpected)}")
    values = {
        name: (
            item
            if item is not None
            and item.network_distance <= scenario.walking_distance
            else None
        )
        for name, item in ((name, nearest.get(name)) for name in _PRESENCE_NAMES)
    }
    present = {name: values[name] is not None for name in _PRESENCE_NAMES}
    geographic = not present["documented"]
    scheduled = not present["open"] and present["scheduled_closed"]
    seasonal = not present["open"] and present["seasonal_closed"]
    temporary_service = not present["open"] and (
        present["temporary_closed"] or present["construction_closed"]
    )
    accessibility = (
        present["open"]
        and present["open_inaccessible"]
        and not present["open_accessible"]
    )
    information = (
        (not present["open"] and present["unknown_hours"])
        or (
            present["open"]
            and not present["open_accessible"]
            and present["open_unknown_accessibility"]
        )
    )
    return GapEvidence(
        stop_id=stop_id,
        scenario_id=scenario.scenario_id,
        walking_distance=scenario.walking_distance,
        **{f"has_{name}": present[name] for name in _PRESENCE_NAMES},
        **{f"nearest_{name}": values[name] for name in _PRESENCE_NAMES},
        geographic_gap=geographic,
        scheduled_time_gap=scheduled,
        seasonal_gap=seasonal,
        temporary_service_gap=temporary_service,
        accessibility_gap=accessibility,
        information_gap=information,
    )


def _metrics_for(candidate: CandidateGain, scenario_id: str) -> ScenarioMetrics:
    if candidate.primary_metrics.scenario_id == scenario_id:
        return candidate.primary_metrics
    for metrics in candidate.sensitivity_metrics:
        if metrics.scenario_id == scenario_id:
            return metrics
    raise ValueError(f"Candidate {candidate.candidate_id} has no metrics for {scenario_id}")


def rank_candidates(
    candidates: Iterable[CandidateGain], *, scenario_id: str
) -> tuple[CandidateGain, ...]:
    """Apply the published lexicographic rank within one intervention group."""
    items = tuple(candidates)
    if not items:
        return ()
    groups = {(item.candidate_class, item.verification_kind) for item in items}
    if len(groups) != 1:
        raise ValueError("Cannot rank mixed rank groups")

    def sort_key(item: CandidateGain) -> tuple[int, int, int, int, str, str, str]:
        metrics = _metrics_for(item, scenario_id)
        tie = item.source_stop_id if item.candidate_class == "new_facility_zone" else item.name
        if not tie:
            raise ValueError(f"Candidate {item.candidate_id} is missing its published tie value")
        combined = metrics.combined_incremental
        return (
            -metrics.positive_late_snapshots,
            -combined.unique_trips,
            -combined.unique_routes,
            -combined.active_stops,
            tie.casefold(),
            tie,
            item.candidate_id,
        )

    ranked = tuple(sorted(items, key=sort_key))
    updated = []
    for index, item in enumerate(ranked, start=1):
        if item.primary_metrics.scenario_id == scenario_id:
            updated.append(replace(item, primary_rank=index))
        else:
            ranks = tuple(
                ScenarioRank(rank.scenario_id, rank.applicable, index)
                if rank.scenario_id == scenario_id and rank.applicable
                else rank
                for rank in item.sensitivity_ranks
            )
            updated.append(replace(item, sensitivity_ranks=ranks))
    return tuple(updated)


def stability_category(ranks: Iterable[ScenarioRank]) -> str:
    """Classify a candidate from its primary rank and applicable sensitivities."""
    values = tuple(ranks)
    primary = values[0] if values else None
    if primary is None or not primary.applicable or primary.rank is None or primary.rank > 20:
        return "not prioritized"
    top_twenty = sum(
        1
        for rank in values
        if rank.applicable and rank.rank is not None and rank.rank <= 20
    )
    if top_twenty >= 5:
        return "robust"
    if top_twenty >= 3:
        return "mostly robust"
    return "sensitive"


def has_material_gain(metrics: ScenarioMetrics, *, walking_distance: int) -> bool:
    """Apply the fixed 400-metre late-service materiality threshold."""
    combined = metrics.combined_incremental
    return (
        walking_distance == 400
        and combined.unique_trips >= 10
        and combined.active_stops >= 3
    )


def evaluate_product_gate(candidates: Iterable[CandidateGain]) -> ProductGateResult:
    """Evaluate all audited robust candidates without cherry-picking failures."""
    counted = tuple(
        candidate
        for candidate in candidates
        if candidate.stability == "robust" and candidate.audit_status == "valid"
    )
    ids = tuple(candidate.candidate_id for candidate in counted)
    if len(counted) < 5:
        return ProductGateResult(False, "fewer than five robust valid candidates", ids)
    if any(not candidate.material_gain for candidate in counted):
        return ProductGateResult(False, "a robust valid candidate is not material", ids)
    if sum(candidate.candidate_class == "extend_hours" for candidate in counted) < 2:
        return ProductGateResult(False, "fewer than two robust valid hours extensions", ids)
    if any(
        candidate.source_error
        or candidate.duplicate_candidate
        or candidate.misclassified_access
        for candidate in counted
    ):
        return ProductGateResult(False, "a robust valid candidate has an integrity flag", ids)
    return ProductGateResult(True, "all product-gate conditions passed", ids)


def _activity_public(metrics: ActivityMetrics) -> dict[str, int]:
    return {
        "unique_trips": metrics.unique_trips,
        "unique_routes": metrics.unique_routes,
        "active_stops": metrics.active_stops,
        "stop_time_events": metrics.stop_time_events,
    }


def _scenario_metrics_public(metrics: ScenarioMetrics) -> dict[str, object]:
    return {
        "scenario_id": metrics.scenario_id,
        "snapshot_gains": [
            {
                "snapshot_id": gain.snapshot_id,
                "incremental": _activity_public(gain.incremental),
                "total_catchment": _activity_public(gain.total_catchment),
            }
            for gain in metrics.snapshot_gains
        ],
        "combined_incremental": _activity_public(metrics.combined_incremental),
        "combined_total": _activity_public(metrics.combined_total),
        "positive_late_snapshots": metrics.positive_late_snapshots,
    }


def candidate_public_projection(candidate: CandidateGain) -> dict[str, object]:
    """Return the complete candidate contract without internal trip identities."""
    facility = None
    if candidate.facility is not None:
        facility = {
            "facility_id": candidate.facility.facility_id,
            "name": candidate.facility.name,
            "source": candidate.facility.source,
            "address": candidate.facility.address,
            "lon": candidate.facility.lon,
            "lat": candidate.facility.lat,
            "hours": candidate.facility.hours,
            "access_condition": candidate.facility.access_condition,
            "closure_category": candidate.facility.closure_category,
            "accessibility": candidate.facility.accessibility,
            "partial_service": candidate.facility.partial_service,
            "source_url": candidate.facility.source_url,
            "notes": candidate.facility.notes,
        }
    return {
        "candidate_id": candidate.candidate_id,
        "candidate_class": candidate.candidate_class,
        "verification_kind": candidate.verification_kind,
        "name": candidate.name,
        "lon": candidate.lon,
        "lat": candidate.lat,
        "source_stop_id": candidate.source_stop_id,
        "facility_id": candidate.facility_id,
        "facility": facility,
        "gain_label": candidate.gain_label,
        "primary_metrics": _scenario_metrics_public(candidate.primary_metrics),
        "sensitivity_metrics": [
            _scenario_metrics_public(metrics) for metrics in candidate.sensitivity_metrics
        ],
        "primary_rank": candidate.primary_rank,
        "sensitivity_ranks": [
            {
                "scenario_id": rank.scenario_id,
                "applicable": rank.applicable,
                "rank": rank.published_rank,
            }
            for rank in candidate.sensitivity_ranks
        ],
        "stability": candidate.stability,
        "material_gain": candidate.material_gain,
        "audit_status": candidate.audit_status,
        "source_error": candidate.source_error,
        "duplicate_candidate": candidate.duplicate_candidate,
        "misclassified_access": candidate.misclassified_access,
        "review_flags": list(candidate.review_flags),
    }
