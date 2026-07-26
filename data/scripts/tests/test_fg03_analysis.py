import json
import unittest
from datetime import date

from fg03_analysis import (
    ActivityMetrics,
    CandidateGain,
    FacilityEvidence,
    FacilitySnapshot,
    NearestFacility,
    Scenario,
    ScenarioMetrics,
    ScenarioRank,
    candidate_public_projection,
    classify_gap,
    eligible_facilities,
    evaluate_product_gate,
    effective_facility_state,
    has_material_gain,
    rank_candidates,
    stability_category,
)


class AnalysisRulesTests(unittest.TestCase):
    def setUp(self):
        self.scenario = Scenario(
            scenario_id="tue-public-observed-400",
            service_date=date(2026, 7, 21),
            snapshot_ids=("2200", "0030"),
            access_mode="public",
            walking_distance=400,
            closure_mode="observed",
            information_mode="unknown_unavailable",
        )
        self.facilities = (
            FacilityEvidence(
                facility_id="library:1",
                name="Library",
                source="Toronto Public Library",
                address="1 Main Street",
                lon=-79.4,
                lat=43.7,
                hours="Mon to Fri 9 a.m. to 9 p.m.",
                access_condition="unrestricted",
                closure_category="none",
                accessibility="accessible",
                partial_service=False,
                source_url="https://example.test/library",
                notes="",
            ),
            FacilityEvidence(
                facility_id="ttc:1",
                name="Station washroom",
                source="TTC",
                address="2 Main Street",
                lon=-79.41,
                lat=43.71,
                hours="Station hours",
                access_condition="fare_paid",
                closure_category="none",
                accessibility="unknown",
                partial_service=False,
                source_url="https://example.test/ttc",
                notes="",
            ),
        )

    def test_public_access_excludes_fare_paid_and_rejects_invalid_mode(self):
        # Protected break: treating fare-paid station access as public coverage hides the access barrier.
        self.assertEqual(
            [item.facility_id for item in eligible_facilities(self.facilities, access_mode="public")],
            ["library:1"],
        )
        with self.assertRaisesRegex(ValueError, "access mode"):
            eligible_facilities(self.facilities, access_mode="all")

    def test_classify_gap_keeps_coexisting_closure_and_information_flags(self):
        # Protected break: an exclusive gap branch suppresses a real scheduled and unknown-hours action.
        gaps = classify_gap(
            stop_id="stop:1",
            scenario=self.scenario,
            nearest={
                "documented": NearestFacility("closed:1", "Closed", 400.0),
                "scheduled_closed": NearestFacility("closed:1", "Closed", 400.0),
                "unknown_hours": NearestFacility("unknown:1", "Unknown", 399.0),
            },
        )

        self.assertTrue(gaps.scheduled_time_gap)
        self.assertTrue(gaps.information_gap)
        self.assertFalse(gaps.geographic_gap)
        self.assertEqual(gaps.nearest_unknown_hours.facility_id, "unknown:1")

    def test_classify_gap_needs_known_inaccessibility_and_open_coverage(self):
        # Protected break: unknown accessibility must not be promoted to an accessibility retrofit gap.
        unknown_only = classify_gap(
            stop_id="stop:unknown",
            scenario=self.scenario,
            nearest={
                "open": NearestFacility("open:1", "Open", 120.0),
                "open_unknown_accessibility": NearestFacility("open:1", "Open", 120.0),
            },
        )
        inaccessible = classify_gap(
            stop_id="stop:barrier",
            scenario=self.scenario,
            nearest={
                "open": NearestFacility("open:2", "Open", 120.0),
                "open_inaccessible": NearestFacility("open:2", "Open", 120.0),
            },
        )

        self.assertFalse(unknown_only.accessibility_gap)
        self.assertTrue(unknown_only.information_gap)
        self.assertTrue(inaccessible.accessibility_gap)

    def test_classify_gap_includes_exact_distance_and_excludes_epsilon_beyond_threshold(self):
        # Protected break: accepting a facility beyond the walking threshold overstates coverage.
        exact = classify_gap(
            stop_id="stop:exact",
            scenario=self.scenario,
            nearest={"documented": NearestFacility("exact:1", "Exact", 400.0)},
        )
        beyond = classify_gap(
            stop_id="stop:beyond",
            scenario=self.scenario,
            nearest={"documented": NearestFacility("beyond:1", "Beyond", 400.001)},
        )

        self.assertFalse(exact.geographic_gap)
        self.assertTrue(beyond.geographic_gap)

    def test_classify_gap_does_not_turn_partial_or_normal_operations_closure_into_gap(self):
        # Protected break: a temporary category alone must not erase an available partial facility.
        observed = classify_gap(
            stop_id="stop:partial",
            scenario=self.scenario,
            nearest={
                "open": NearestFacility("park:1", "Partial park washroom", 400.0),
                "temporary_closed": NearestFacility("park:1", "Partial park washroom", 400.0),
            },
        )
        normal = classify_gap(
            stop_id="stop:normal",
            scenario=Scenario(
                scenario_id="normal",
                service_date=date(2026, 7, 21),
                snapshot_ids=("2200",),
                access_mode="public",
                walking_distance=400,
                closure_mode="normal_operations",
                information_mode="unknown_unavailable",
            ),
            nearest={"open": NearestFacility("park:2", "Reopened", 400.0)},
        )

        self.assertFalse(observed.temporary_service_gap)
        self.assertFalse(normal.temporary_service_gap)

    def test_normal_operations_uses_scheduled_state_only_for_temporary_overrides(self):
        # Protected break: copying observed state makes the normal-operations sensitivity inert.
        normal = Scenario(
            scenario_id="normal",
            service_date=date(2026, 7, 21),
            snapshot_ids=("2200",),
            access_mode="public",
            walking_distance=400,
            closure_mode="normal_operations",
            information_mode="unknown_unavailable",
        )
        observed = self.scenario

        self.assertEqual(
            effective_facility_state(
                FacilitySnapshot("park:temporary-open", "2200", "open", "temporary_closed"),
                normal,
            ),
            "open",
        )
        self.assertEqual(
            effective_facility_state(
                FacilitySnapshot("park:temporary-closed", "2200", "closed", "temporary_closed"),
                normal,
            ),
            "scheduled_closed",
        )
        self.assertEqual(
            effective_facility_state(
                FacilitySnapshot("park:temporary-unknown", "2200", "unknown", "temporary_closed"),
                normal,
            ),
            "unknown_hours",
        )
        self.assertEqual(
            effective_facility_state(
                FacilitySnapshot("park:observed", "2200", "open", "temporary_closed"),
                observed,
            ),
            "temporary_closed",
        )
        self.assertEqual(
            effective_facility_state(
                FacilitySnapshot("park:seasonal", "2200", "open", "seasonal_closed"),
                normal,
            ),
            "seasonal_closed",
        )
        self.assertEqual(
            effective_facility_state(
                FacilitySnapshot("park:construction", "2200", "open", "construction_closed"),
                normal,
            ),
            "construction_closed",
        )

    def test_optimistic_unknown_hours_remains_potential(self):
        # Protected break: labelling optimistic information as open turns an assumption into confirmed service.
        optimistic = Scenario(
            scenario_id="optimistic",
            service_date=date(2026, 7, 21),
            snapshot_ids=("2200",),
            access_mode="public",
            walking_distance=400,
            closure_mode="observed",
            information_mode="optimistic_information",
        )
        snapshot = FacilitySnapshot("unknown:1", "2200", "unknown", "unknown_hours")

        self.assertEqual(effective_facility_state(snapshot, self.scenario), "unknown_hours")
        self.assertEqual(effective_facility_state(snapshot, optimistic), "potential_open")

    def test_rank_candidates_uses_all_lexicographic_keys_and_rejects_mixed_groups(self):
        # Protected break: omitting case-preserving or candidate-ID ties makes published ranks unstable.
        metrics = ScenarioMetrics(
            scenario_id=self.scenario.scenario_id,
            snapshot_gains=(),
            combined_incremental=ActivityMetrics(12, 3, 4, 9),
            combined_total=ActivityMetrics(12, 3, 4, 9),
            positive_late_snapshots=2,
            _effect_trip_keys=frozenset({("2200", "one")}),
        )
        candidates = (
            self._candidate("extend-hours:z", "alpha", metrics),
            self._candidate("extend-hours:a", "Alpha", metrics),
        )

        ranked = rank_candidates(candidates, scenario_id=self.scenario.scenario_id)
        self.assertEqual([(item.candidate_id, item.primary_rank) for item in ranked], [("extend-hours:a", 1), ("extend-hours:z", 2)])
        with self.assertRaisesRegex(ValueError, "mixed rank groups"):
            rank_candidates(
                candidates + (self._candidate("retrofit-accessibility:x", "Alpha", metrics, candidate_class="retrofit_accessibility"),),
                scenario_id=self.scenario.scenario_id,
            )

    def test_rank_candidates_protects_each_metric_and_stable_tie_key(self):
        # Protected break: changing any tuple position changes the published intervention order.
        cases = (
            (
                self._rank_metrics(1, 99, 99, 99),
                self._rank_metrics(2, 1, 1, 1),
                "Beta",
                "Alpha",
                "extend-hours:loser",
                "extend-hours:winner",
            ),
            (
                self._rank_metrics(2, 10, 99, 99),
                self._rank_metrics(2, 11, 1, 1),
                "Beta",
                "Alpha",
                "extend-hours:loser",
                "extend-hours:winner",
            ),
            (
                self._rank_metrics(2, 11, 3, 99),
                self._rank_metrics(2, 11, 4, 1),
                "Beta",
                "Alpha",
                "extend-hours:loser",
                "extend-hours:winner",
            ),
            (
                self._rank_metrics(2, 11, 4, 4),
                self._rank_metrics(2, 11, 4, 5),
                "Beta",
                "Alpha",
                "extend-hours:loser",
                "extend-hours:winner",
            ),
            (
                self._rank_metrics(2, 11, 4, 5),
                self._rank_metrics(2, 11, 4, 5),
                "beta",
                "Alpha",
                "extend-hours:loser",
                "extend-hours:winner",
            ),
            (
                self._rank_metrics(2, 11, 4, 5),
                self._rank_metrics(2, 11, 4, 5),
                "alpha",
                "Alpha",
                "extend-hours:loser",
                "extend-hours:winner",
            ),
            (
                self._rank_metrics(2, 11, 4, 5),
                self._rank_metrics(2, 11, 4, 5),
                "Alpha",
                "Alpha",
                "extend-hours:z",
                "extend-hours:a",
            ),
        )
        for loser_metrics, winner_metrics, loser_name, winner_name, loser_id, winner_id in cases:
            with self.subTest(winner_id=winner_id, loser_id=loser_id):
                ranked = rank_candidates(
                    (
                        self._candidate(loser_id, loser_name, loser_metrics),
                        self._candidate(winner_id, winner_name, winner_metrics),
                    ),
                    scenario_id=self.scenario.scenario_id,
                )
                self.assertEqual(ranked[0].candidate_id, winner_id)

        zone_metrics = self._rank_metrics(2, 11, 4, 5)
        zones = (
            self._candidate(
                "new-facility-zone:z",
                "A misleading label",
                zone_metrics,
                candidate_class="new_facility_zone",
                source_stop_id="stop-z",
            ),
            self._candidate(
                "new-facility-zone:a",
                "Z misleading label",
                zone_metrics,
                candidate_class="new_facility_zone",
                source_stop_id="stop-a",
            ),
        )
        self.assertEqual(
            rank_candidates(zones, scenario_id=self.scenario.scenario_id)[0].candidate_id,
            "new-facility-zone:a",
        )

    def test_stability_ignores_not_applicable_ranks_and_material_uses_400_metres(self):
        # Protected break: counting non-applicable scenarios as misses downgrades valid candidates.
        ranks = (
            ScenarioRank("primary", True, 1),
            ScenarioRank("300", True, 2),
            ScenarioRank("500", True, 8),
            ScenarioRank("rider", True, 20),
            ScenarioRank("normal", True, 21),
            ScenarioRank("information", False, None),
            ScenarioRank("saturday", True, 3),
        )
        metrics = ScenarioMetrics(
            scenario_id=self.scenario.scenario_id,
            snapshot_gains=(),
            combined_incremental=ActivityMetrics(10, 2, 3, 5),
            combined_total=ActivityMetrics(11, 2, 3, 5),
            positive_late_snapshots=1,
            _effect_trip_keys=frozenset({("2200", str(index)) for index in range(10)}),
        )

        self.assertEqual(stability_category(ranks), "robust")
        self.assertTrue(has_material_gain(metrics, walking_distance=400))
        self.assertFalse(has_material_gain(metrics, walking_distance=300))

    def test_scenario_rank_serializes_only_non_applicable_as_text(self):
        # Protected break: using zero or an invented rank for a non-applicable sensitivity distorts stability.
        pending = ScenarioRank("saturday", True, None)
        not_applicable = ScenarioRank("information", False, None)

        self.assertIsNone(pending.published_rank)
        self.assertEqual(not_applicable.published_rank, "not applicable")

    def test_stability_categories_protect_every_boundary(self):
        # Protected break: an off-by-one at three or five top-20 ranks changes audit scope.
        def ranks(top_twenty_count, *, primary_rank=1):
            return (
                ScenarioRank("primary", True, primary_rank),
                *tuple(
                    ScenarioRank(f"sensitivity-{index}", True, 20 if index < top_twenty_count - 1 else 21)
                    for index in range(6)
                ),
            )

        self.assertEqual(stability_category(ranks(5)), "robust")
        self.assertEqual(stability_category(ranks(4)), "mostly robust")
        self.assertEqual(stability_category(ranks(3)), "mostly robust")
        self.assertEqual(stability_category(ranks(2)), "sensitive")
        self.assertEqual(stability_category(ranks(5, primary_rank=21)), "not prioritized")
        self.assertEqual(stability_category(()), "not prioritized")

    def test_stability_uses_first_rank_as_primary_without_magic_scenario_id(self):
        # Protected break: matching a literal ID can treat a sensitivity as the primary rank.
        ranks = (
            ScenarioRank("tuesday-public-400", True, 21),
            ScenarioRank("primary", True, 1),
            ScenarioRank("distance-300", True, 1),
            ScenarioRank("distance-500", True, 1),
            ScenarioRank("rider", True, 1),
        )

        self.assertEqual(stability_category(ranks), "not prioritized")

    def test_product_gate_fails_for_each_required_condition_and_extra_nonmaterial_candidate(self):
        # Protected break: filtering nonmaterial robust valid rows before the gate permits cherry-picking.
        valid = tuple(
            self._candidate(
                f"extend-hours:{index}",
                f"Hours {index}",
                self._material_metrics(),
                stability="robust",
                material_gain=True,
                audit_status="valid",
            )
            for index in range(2)
        ) + tuple(
            self._candidate(
                f"new-facility-zone:{index}",
                f"Zone {index}",
                self._material_metrics(),
                candidate_class="new_facility_zone",
                stability="robust",
                material_gain=True,
                audit_status="valid",
            )
            for index in range(3)
        )
        self.assertTrue(evaluate_product_gate(valid).passed)
        self.assertFalse(evaluate_product_gate(valid[:4]).passed)
        self.assertFalse(evaluate_product_gate(valid[1:]).passed)
        self.assertFalse(evaluate_product_gate(valid + (self._candidate("new-facility-zone:extra", "Extra", self._material_metrics(), candidate_class="new_facility_zone", stability="robust", material_gain=False, audit_status="valid"),)).passed)
        self.assertFalse(evaluate_product_gate(valid + (self._candidate("new-facility-zone:flagged", "Flagged", self._material_metrics(), candidate_class="new_facility_zone", stability="robust", material_gain=True, audit_status="valid", source_error=True),)).passed)

    def test_product_gate_two_hours_condition_is_independent_of_candidate_count(self):
        # Protected break: fewer than two hours actions must fail even when five valid robust rows exist.
        one_hours_candidate = (
            self._candidate(
                "extend-hours:only",
                "Only hours action",
                self._material_metrics(),
                stability="robust",
                material_gain=True,
                audit_status="valid",
            ),
        )
        four_other_candidates = tuple(
            self._candidate(
                f"new-facility-zone:{index}",
                f"Zone {index}",
                self._material_metrics(),
                candidate_class="new_facility_zone",
                source_stop_id=f"stop-{index}",
                stability="robust",
                material_gain=True,
                audit_status="valid",
            )
            for index in range(4)
        )

        result = evaluate_product_gate(one_hours_candidate + four_other_candidates)

        self.assertFalse(result.passed)
        self.assertIn("two", result.reason)

    def test_candidate_rejects_illegal_class_kind_and_stability_values(self):
        # Protected break: malformed rank groups can otherwise enter sorting and product-gate logic.
        with self.assertRaisesRegex(ValueError, "verification kind"):
            self._candidate(
                "extend-hours:bad",
                "Bad hours",
                self._material_metrics(),
                verification_kind="hours",
            )
        with self.assertRaisesRegex(ValueError, "verification kind"):
            self._candidate(
                "verify-hours:missing",
                "Missing kind",
                self._material_metrics(),
                candidate_class="verify_information",
            )
        with self.assertRaisesRegex(ValueError, "stability"):
            self._candidate(
                "extend-hours:unstable",
                "Invalid stability",
                self._material_metrics(),
                stability="very robust",
            )

    def test_candidate_public_projection_recursively_strips_internal_trip_keys(self):
        # Protected break: recursively serializing CandidateGain exposes raw scheduled trip IDs.
        metrics = ScenarioMetrics(
            scenario_id="primary",
            snapshot_gains=(),
            combined_incremental=ActivityMetrics(1, 1, 1, 1),
            combined_total=ActivityMetrics(1, 1, 1, 1),
            positive_late_snapshots=1,
            _effect_trip_keys=frozenset({("2200", "trip-secret")}),
        )
        candidate = self._candidate(
            "extend-hours:public",
            "Public projection",
            metrics,
            stability="mostly robust",
        )

        projection = candidate_public_projection(candidate)
        serialized = json.dumps(projection, sort_keys=True)

        self.assertNotIn("trip-secret", serialized)
        self.assertNotIn("_effect_trip_keys", serialized)
        self.assertEqual(
            projection["primary_metrics"]["combined_incremental"]["unique_trips"],
            1,
        )

    def _material_metrics(self):
        return ScenarioMetrics(
            scenario_id=self.scenario.scenario_id,
            snapshot_gains=(),
            combined_incremental=ActivityMetrics(10, 2, 3, 4),
            combined_total=ActivityMetrics(10, 2, 3, 4),
            positive_late_snapshots=2,
            _effect_trip_keys=frozenset({("2200", str(index)) for index in range(10)}),
        )

    def _rank_metrics(self, snapshots, trips, routes, stops):
        return ScenarioMetrics(
            scenario_id=self.scenario.scenario_id,
            snapshot_gains=(),
            combined_incremental=ActivityMetrics(trips, routes, stops, trips),
            combined_total=ActivityMetrics(trips, routes, stops, trips),
            positive_late_snapshots=snapshots,
            _effect_trip_keys=frozenset({("2200", "rank-fixture")}),
        )

    def _candidate(
        self,
        candidate_id,
        name,
        metrics,
        *,
        candidate_class="extend_hours",
        verification_kind=None,
        source_stop_id=None,
        stability="sensitive",
        material_gain=False,
        audit_status="valid",
        source_error=False,
    ):
        return CandidateGain(
            candidate_id=candidate_id,
            candidate_class=candidate_class,
            verification_kind=verification_kind,
            name=name,
            lon=-79.4,
            lat=43.7,
            source_stop_id=source_stop_id,
            facility_id=None,
            facility=None,
            gain_label="incremental",
            primary_metrics=metrics,
            sensitivity_metrics=(),
            primary_rank=None,
            sensitivity_ranks=(),
            stability=stability,
            material_gain=material_gain,
            audit_status=audit_status,
            source_error=source_error,
            duplicate_candidate=False,
            misclassified_access=False,
            review_flags=(),
        )


if __name__ == "__main__":
    unittest.main()
