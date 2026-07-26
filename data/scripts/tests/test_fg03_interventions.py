import unittest
from datetime import date

from fg03_analysis import FacilityEvidence, FacilitySnapshot, Scenario
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
from fg03_transit import ActiveStopEvent


class InterventionSimulationTests(unittest.TestCase):
    def setUp(self):
        self.scenario = Scenario(
            scenario_id="primary",
            service_date=date(2026, 7, 21),
            snapshot_ids=("2200", "0030"),
            access_mode="public",
            walking_distance=400,
            closure_mode="observed",
            information_mode="unknown_unavailable",
        )
        self.events = (
            SnapshotEvents(
                "2200",
                (
                    self._event("a", "trip-shared", "501"),
                    self._event("b", "trip-shared", "501"),
                    self._event("c", "trip-c", "502"),
                    self._event("e", "trip-e", "504"),
                ),
            ),
            SnapshotEvents(
                "0030",
                (
                    self._event("a", "trip-shared", "501"),
                    self._event("d", "trip-d", "503"),
                    self._event("f", "trip-f", "505"),
                    self._event("g", "trip-g", "506"),
                ),
            ),
        )
        self.inputs = ScenarioInputs(
            scenario=self.scenario,
            snapshot_events=self.events,
            baseline_covered=(
                SnapshotStops("2200", frozenset({"a"})),
                SnapshotStops("0030", frozenset({"a"})),
            ),
        )
        self.facility = FacilityEvidence(
            facility_id="library:1",
            name="Library",
            source="Library",
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
        )
        self.footprint = CoverageFootprint(
            source_id="library:1",
            node_id="node-library",
            stops_by_snapshot={"2200": frozenset({"a", "b", "c"}), "0030": frozenset({"a", "d"})},
        )

    def test_hours_extension_uses_incremental_coverage_and_excludes_non_schedule_closures(self):
        # Protected break: calculating catchment totals as gain promotes already-covered stop events.
        candidates = simulate_hours_extensions(
            self.inputs,
            facilities=(self.facility,),
            snapshots=(
                FacilitySnapshot("library:1", "2200", "closed", "scheduled_closed"),
                FacilitySnapshot("library:1", "0030", "closed", "scheduled_closed"),
            ),
            footprints={"library:1": self.footprint},
        )
        self.assertEqual(len(candidates), 1)
        metrics = candidates[0].primary_metrics
        self.assertEqual(metrics.combined_incremental.unique_trips, 3)
        self.assertEqual(metrics.combined_incremental.active_stops, 3)
        self.assertEqual(metrics.combined_total.unique_trips, 4)
        self.assertEqual(metrics.combined_total.stop_time_events, 5)
        excluded = simulate_hours_extensions(
            self.inputs,
            facilities=(self.facility,),
            snapshots=(
                FacilitySnapshot("library:1", "2200", "closed", "temporary_closed"),
                FacilitySnapshot("library:1", "0030", "unknown", "unknown_hours"),
            ),
            footprints={"library:1": self.footprint},
        )
        self.assertEqual(excluded, ())

    def test_hours_extension_excludes_mixed_seasonal_closure(self):
        # Protected break: one scheduled closure must not hide a seasonal closure.
        self._assert_mixed_hours_state_excluded("open", "seasonal_closed")

    def test_hours_extension_excludes_mixed_temporary_closure(self):
        # Protected break: one scheduled closure must not turn a service outage into an hours action.
        self._assert_mixed_hours_state_excluded("open", "temporary_closed")

    def test_hours_extension_excludes_mixed_construction_closure(self):
        # Protected break: one scheduled closure must not turn construction into an hours action.
        self._assert_mixed_hours_state_excluded("open", "construction_closed")

    def test_hours_extension_excludes_mixed_unknown_hours(self):
        # Protected break: one scheduled closure must not turn missing hours into an hours action.
        self._assert_mixed_hours_state_excluded("unknown", "unknown_hours")

    def test_hours_extension_excludes_mixed_open_state(self):
        # Protected break: all relevant late snapshots must be unavailable through schedule alone.
        self._assert_mixed_hours_state_excluded("open", "open")

    def test_hours_extension_keeps_fare_paid_gain_out_of_public_mode(self):
        # Protected break: a public scenario must not claim station-only gains.
        fare_paid = FacilityEvidence(
            facility_id="ttc:1",
            name="Station washroom",
            source="TTC",
            address="2 Main Street",
            lon=-79.4,
            lat=43.7,
            hours="Station hours",
            access_condition="fare_paid",
            closure_category="none",
            accessibility="unknown",
            partial_service=False,
            source_url="https://example.test/ttc",
            notes="",
        )
        candidates = simulate_hours_extensions(
            self.inputs,
            facilities=(fare_paid,),
            snapshots=(FacilitySnapshot("ttc:1", "2200", "closed", "scheduled_closed"),),
            footprints={"ttc:1": self.footprint},
        )
        self.assertEqual(candidates, ())

    def test_hours_extensions_populate_sensitivities_and_ignore_optimistic_information(self):
        # Protected break: primary-only assembly can never produce a robust opportunity.
        sensitivities = (
            self._inputs("distance-300", walking_distance=300),
            self._inputs("distance-500", walking_distance=500),
            self._inputs("rider", access_mode="rider_conditional"),
            self._inputs("normal", closure_mode="normal_operations"),
            self._inputs("optimistic", information_mode="optimistic_information"),
            self._inputs("saturday", service_date=date(2026, 7, 25)),
        )
        sensitivity_footprints = {
            inputs.scenario.scenario_id: {"library:1": self.footprint}
            for inputs in sensitivities
        }

        candidate = simulate_hours_extensions(
            self.inputs,
            sensitivity_inputs=sensitivities,
            facilities=(self.facility,),
            snapshots=(
                FacilitySnapshot("library:1", "2200", "closed", "scheduled_closed"),
                FacilitySnapshot("library:1", "0030", "closed", "scheduled_closed"),
            ),
            footprints={"library:1": self.footprint},
            sensitivity_footprints=sensitivity_footprints,
        )[0]

        self.assertEqual(
            [metrics.scenario_id for metrics in candidate.sensitivity_metrics],
            ["distance-300", "distance-500", "rider", "normal", "saturday"],
        )
        self.assertEqual(
            [
                (rank.scenario_id, rank.applicable, rank.published_rank)
                for rank in candidate.sensitivity_ranks
            ],
            [
                ("distance-300", True, 1),
                ("distance-500", True, 1),
                ("rider", True, 1),
                ("normal", True, 1),
                ("optimistic", False, "not applicable"),
                ("saturday", True, 1),
            ],
        )
        self.assertEqual(candidate.stability, "robust")

    def test_retrofit_sensitivities_apply_normal_and_optimistic_effective_states(self):
        # Protected break: ignoring scenario modes leaves temporary and unknown-hour snapshots inert.
        inaccessible = FacilityEvidence(
            facility_id="barrier:modes",
            name="Barrier modes",
            source="Library",
            address="6 Main Street",
            lon=-79.4,
            lat=43.7,
            hours="Mixed",
            access_condition="unrestricted",
            closure_category="none",
            accessibility="inaccessible",
            partial_service=False,
            source_url="https://example.test/barrier-modes",
            notes="stairs only",
        )
        normal = self._inputs("normal", closure_mode="normal_operations")
        optimistic = self._inputs(
            "optimistic", information_mode="optimistic_information"
        )
        snapshots = (
            FacilitySnapshot("barrier:modes", "2200", "open", "open"),
            FacilitySnapshot("barrier:modes", "0030", "open", "temporary_closed"),
        )
        candidate = simulate_accessibility_retrofits(
            self.inputs,
            sensitivity_inputs=(normal,),
            facilities=(inaccessible,),
            snapshots=snapshots,
            footprints={"barrier:modes": self.footprint},
            sensitivity_footprints={"normal": {"barrier:modes": self.footprint}},
        )[0]
        self.assertEqual(candidate.primary_metrics.combined_incremental.unique_trips, 2)
        self.assertEqual(
            candidate.sensitivity_metrics[0].combined_incremental.unique_trips,
            3,
        )

        optimistic_candidate = simulate_accessibility_retrofits(
            self.inputs,
            sensitivity_inputs=(optimistic,),
            facilities=(inaccessible,),
            snapshots=(
                FacilitySnapshot("barrier:modes", "2200", "open", "open"),
                FacilitySnapshot("barrier:modes", "0030", "unknown", "unknown_hours"),
            ),
            footprints={"barrier:modes": self.footprint},
            sensitivity_footprints={
                "optimistic": {"barrier:modes": self.footprint}
            },
        )[0]
        self.assertTrue(optimistic_candidate.sensitivity_ranks[0].applicable)
        self.assertEqual(
            optimistic_candidate.sensitivity_metrics[0].combined_incremental.unique_trips,
            3,
        )

    def test_new_zones_collapse_shared_nodes_and_apply_pairwise_eighty_percent_overlap(self):
        # Protected break: merging against the union or the wrong denominator changes the candidate universe.
        seeds = (
            NewFacilitySeed("stop-b", "B", -79.4, 43.7, "same-node", self._footprint("stop-b", {"a", "b", "c", "e"}, {"a", "d", "f"})),
            NewFacilitySeed("stop-a", "A", -79.4, 43.7, "same-node", self._footprint("stop-a", {"a", "b", "c", "e"}, {"a", "d", "f"})),
            NewFacilitySeed("stop-c", "C", -79.4, 43.7, "node-c", self._footprint("stop-c", {"a", "b", "c", "e"}, {"a", "d", "f"})),
            NewFacilitySeed("stop-d", "D", -79.4, 43.7, "node-d", self._footprint("stop-d", {"a", "b", "c"}, {"a", "d", "g"})),
            NewFacilitySeed("stop-e", "E", -79.4, 43.7, "node-e", self._footprint("stop-e", {"a", "b", "c"}, {"a", "d", "f", "g"})),
        )
        candidates = simulate_new_facility_zones(self.inputs, seeds=seeds)

        self.assertEqual([item.candidate_id for item in candidates], ["new-facility-zone:stop-a", "new-facility-zone:stop-d"])

    def test_new_zone_universe_requires_primary_policy_scenario(self):
        # Protected break: deduplicating under a distance sensitivity changes the published universe.
        seed = NewFacilitySeed(
            "stop-a",
            "A",
            -79.4,
            43.7,
            "node-a",
            self.footprint,
        )
        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(
                self._inputs("distance-300", walking_distance=300),
                seeds=(seed,),
            )
        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(
                self._inputs("other-tuesday", service_date=date(2026, 7, 28)),
                seeds=(seed,),
            )

    def test_new_zone_primary_rejects_wrong_two_snapshot_ids(self):
        # Protected break: checking only tuple length accepts unrelated observation windows.
        inputs, seed = self._zone_snapshot_fixture(("1200", "2030"))

        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(inputs, seeds=(seed,))

    def test_new_zone_primary_rejects_duplicate_snapshot_ids(self):
        # Protected break: duplicate late IDs can double-count one observation window.
        inputs, seed = self._zone_snapshot_fixture(("2200", "2200"))

        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(inputs, seeds=(seed,))

    def test_new_zone_primary_rejects_reversed_snapshot_order(self):
        # Protected break: accepting reversed IDs breaks the published snapshot ordering contract.
        inputs, seed = self._zone_snapshot_fixture(("0030", "2200"))

        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(inputs, seeds=(seed,))

    def test_new_zone_primary_rejects_missing_snapshot_id(self):
        # Protected break: a one-window effect cannot define the two-window primary universe.
        inputs, seed = self._zone_snapshot_fixture(("2200",))

        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(inputs, seeds=(seed,))

    def test_new_zone_primary_rejects_extra_snapshot_id(self):
        # Protected break: an extra context window must not alter primary effect deduplication.
        inputs, seed = self._zone_snapshot_fixture(("2200", "0030", "1200"))

        with self.assertRaisesRegex(ValueError, "primary"):
            simulate_new_facility_zones(inputs, seeds=(seed,))

    def test_new_zone_primary_accepts_exact_late_snapshot_tuple(self):
        # Protected break: tightening validation must preserve the exact published primary tuple.
        inputs, seed = self._zone_snapshot_fixture(("2200", "0030"))

        candidates = simulate_new_facility_zones(inputs, seeds=(seed,))

        self.assertEqual(
            [candidate.candidate_id for candidate in candidates],
            ["new-facility-zone:candidate-stop"],
        )

    def test_new_zone_sensitivities_rerun_only_frozen_primary_ids(self):
        # Protected break: rededuplicating a sensitivity can add a primary-rejected zone.
        primary_seeds = (
            NewFacilitySeed(
                "stop-a",
                "A",
                -79.4,
                43.7,
                "node-a",
                self._footprint("stop-a", {"a", "b", "c"}, {"a", "d"}),
            ),
            NewFacilitySeed(
                "stop-b",
                "B",
                -79.4,
                43.7,
                "node-b",
                self._footprint("stop-b", {"a", "b", "c"}, {"a", "d"}),
            ),
        )
        sensitivity = self._inputs("distance-300", walking_distance=300)
        sensitivity_seeds = {
            "distance-300": (
                NewFacilitySeed(
                    "stop-a",
                    "A",
                    -79.4,
                    43.7,
                    "node-a",
                    self._footprint("stop-a", {"a", "b"}, {"a"}),
                ),
                NewFacilitySeed(
                    "stop-b",
                    "B",
                    -79.4,
                    43.7,
                    "node-b",
                    self._footprint("stop-b", {"a", "b", "c"}, {"a", "d"}),
                ),
            )
        }

        candidates = simulate_new_facility_zones(
            self.inputs,
            sensitivity_inputs=(sensitivity,),
            seeds=primary_seeds,
            sensitivity_seeds=sensitivity_seeds,
        )

        self.assertEqual(
            [candidate.candidate_id for candidate in candidates],
            ["new-facility-zone:stop-a"],
        )
        self.assertEqual(
            candidates[0].sensitivity_metrics[0].combined_incremental.unique_trips,
            1,
        )

    def test_new_zone_keeps_79_99_percent_and_rejects_80_percent_overlap(self):
        # Protected break: rounding the overlap ratio changes the threshold boundary.
        all_events = tuple(
            self._event(f"stop-{index}", f"trip-{index}", "route")
            for index in range(14_001)
        )
        inputs = ScenarioInputs(
            scenario=self.scenario,
            snapshot_events=(
                SnapshotEvents("2200", all_events),
                SnapshotEvents("0030", ()),
            ),
            baseline_covered=(
                SnapshotStops("2200", frozenset()),
                SnapshotStops("0030", frozenset()),
            ),
        )
        kept_effect = {f"stop-{index}" for index in range(10_000)}
        overlap_79_99 = {
            *(f"stop-{index}" for index in range(7_999)),
            *(f"stop-{index}" for index in range(10_000, 12_001)),
        }
        overlap_80 = {
            *(f"stop-{index}" for index in range(8_000)),
            *(f"stop-{index}" for index in range(12_001, 14_001)),
        }
        seeds = (
            NewFacilitySeed(
                "stop-a",
                "A",
                -79.4,
                43.7,
                "node-a",
                self._footprint("stop-a", kept_effect, set()),
            ),
            NewFacilitySeed(
                "stop-b",
                "B",
                -79.4,
                43.7,
                "node-b",
                self._footprint("stop-b", overlap_79_99, set()),
            ),
            NewFacilitySeed(
                "stop-c",
                "C",
                -79.4,
                43.7,
                "node-c",
                self._footprint("stop-c", overlap_80, set()),
            ),
        )

        candidates = simulate_new_facility_zones(inputs, seeds=seeds)

        self.assertEqual(
            [candidate.candidate_id for candidate in candidates],
            ["new-facility-zone:stop-a", "new-facility-zone:stop-b"],
        )

    def test_information_verification_returns_separate_potential_actions(self):
        # Protected break: combining unknown hours and unknown accessibility turns assumptions into confirmed gain.
        unknown_hours = FacilityEvidence(
            facility_id="unknown-hours:1",
            name="Hours unknown",
            source="Library",
            address="4 Main Street",
            lon=-79.4,
            lat=43.7,
            hours="",
            access_condition="unrestricted",
            closure_category="none",
            accessibility="accessible",
            partial_service=False,
            source_url="https://example.test/hours",
            notes="",
        )
        unknown_accessibility = FacilityEvidence(
            facility_id="unknown-access:1",
            name="Access unknown",
            source="Library",
            address="5 Main Street",
            lon=-79.4,
            lat=43.7,
            hours="Open",
            access_condition="unrestricted",
            closure_category="none",
            accessibility="unknown",
            partial_service=False,
            source_url="https://example.test/access",
            notes="",
        )
        candidates = simulate_information_verification(
            self.inputs,
            facilities=(unknown_hours, unknown_accessibility),
            snapshots=(
                FacilitySnapshot("unknown-hours:1", "2200", "unknown", "unknown_hours"),
                FacilitySnapshot("unknown-access:1", "2200", "open", "open"),
            ),
            footprints={
                "unknown-hours:1": self.footprint,
                "unknown-access:1": self.footprint,
            },
        )
        self.assertEqual(
            [(item.candidate_id, item.verification_kind, item.gain_label) for item in candidates],
            [
                ("verify-accessibility:unknown-access:1", "accessibility", "potential_if_verified"),
                ("verify-hours:unknown-hours:1", "hours", "potential_if_verified"),
            ],
        )

    def test_information_verification_marks_optimistic_sensitivity_not_applicable(self):
        # Protected break: ranking an optimistic verification scenario assumes the fact being verified.
        unknown_hours = FacilityEvidence(
            facility_id="unknown-hours:2",
            name="Hours unknown",
            source="Library",
            address="7 Main Street",
            lon=-79.4,
            lat=43.7,
            hours="",
            access_condition="unrestricted",
            closure_category="none",
            accessibility="accessible",
            partial_service=False,
            source_url="https://example.test/hours-2",
            notes="",
        )
        normal = self._inputs("normal", closure_mode="normal_operations")
        optimistic = self._inputs(
            "optimistic", information_mode="optimistic_information"
        )
        candidate = simulate_information_verification(
            self.inputs,
            sensitivity_inputs=(normal, optimistic),
            facilities=(unknown_hours,),
            snapshots=(
                FacilitySnapshot(
                    "unknown-hours:2", "2200", "unknown", "unknown_hours"
                ),
            ),
            footprints={"unknown-hours:2": self.footprint},
            sensitivity_footprints={
                "normal": {"unknown-hours:2": self.footprint},
                "optimistic": {"unknown-hours:2": self.footprint},
            },
        )[0]

        self.assertEqual(
            [(rank.scenario_id, rank.applicable) for rank in candidate.sensitivity_ranks],
            [("normal", True), ("optimistic", False)],
        )
        self.assertEqual(
            [metrics.scenario_id for metrics in candidate.sensitivity_metrics],
            ["normal"],
        )

    def test_retrofit_requires_known_barrier_and_does_not_open_closed_facility(self):
        # Protected break: treating unknown or closed facilities as retrofit candidates invents accessible service.
        inaccessible = FacilityEvidence(
            facility_id="barrier:1",
            name="Barrier",
            source="Library",
            address="3 Main Street",
            lon=-79.4,
            lat=43.7,
            hours="Open",
            access_condition="unrestricted",
            closure_category="none",
            accessibility="inaccessible",
            partial_service=False,
            source_url="https://example.test/barrier",
            notes="stairs only",
        )
        open_candidate = simulate_accessibility_retrofits(
            self.inputs,
            facilities=(inaccessible,),
            snapshots=(FacilitySnapshot("barrier:1", "2200", "open", "open"),),
            footprints={"barrier:1": self.footprint},
        )
        closed_candidate = simulate_accessibility_retrofits(
            self.inputs,
            facilities=(inaccessible,),
            snapshots=(FacilitySnapshot("barrier:1", "2200", "closed", "scheduled_closed"),),
            footprints={"barrier:1": self.footprint},
        )
        self.assertEqual(open_candidate[0].candidate_id, "retrofit-accessibility:barrier:1")
        self.assertEqual(open_candidate[0].gain_label, "incremental")
        self.assertEqual(closed_candidate, ())

    def _footprint(self, source_id, at_2200, at_0030):
        return CoverageFootprint(source_id, f"node-{source_id}", {"2200": frozenset(at_2200), "0030": frozenset(at_0030)})

    def _assert_mixed_hours_state_excluded(self, scheduled_state, observed_state):
        candidates = simulate_hours_extensions(
            self.inputs,
            facilities=(self.facility,),
            snapshots=(
                FacilitySnapshot(
                    "library:1", "2200", "closed", "scheduled_closed"
                ),
                FacilitySnapshot(
                    "library:1", "0030", scheduled_state, observed_state
                ),
            ),
            footprints={"library:1": self.footprint},
        )

        self.assertEqual(candidates, ())

    def _zone_snapshot_fixture(self, snapshot_ids):
        unique_snapshot_ids = tuple(dict.fromkeys(snapshot_ids))
        snapshot_events = tuple(
            SnapshotEvents(
                snapshot_id,
                (
                    self._event(
                        "candidate-stop",
                        f"trip-{snapshot_id}",
                        "route",
                    ),
                ),
            )
            for snapshot_id in unique_snapshot_ids
        )
        baseline = tuple(
            SnapshotStops(snapshot_id, frozenset())
            for snapshot_id in unique_snapshot_ids
        )
        inputs = ScenarioInputs(
            scenario=Scenario(
                scenario_id="primary-snapshot-contract",
                service_date=date(2026, 7, 21),
                snapshot_ids=snapshot_ids,
                access_mode="public",
                walking_distance=400,
                closure_mode="observed",
                information_mode="unknown_unavailable",
            ),
            snapshot_events=snapshot_events,
            baseline_covered=baseline,
        )
        seed = NewFacilitySeed(
            "candidate-stop",
            "Candidate stop",
            -79.4,
            43.7,
            "candidate-node",
            CoverageFootprint(
                source_id="candidate-stop",
                node_id="candidate-node",
                stops_by_snapshot={
                    snapshot_id: frozenset({"candidate-stop"})
                    for snapshot_id in unique_snapshot_ids
                },
            ),
        )
        return inputs, seed

    def _inputs(
        self,
        scenario_id,
        *,
        service_date=date(2026, 7, 21),
        access_mode="public",
        walking_distance=400,
        closure_mode="observed",
        information_mode="unknown_unavailable",
    ):
        return ScenarioInputs(
            scenario=Scenario(
                scenario_id=scenario_id,
                service_date=service_date,
                snapshot_ids=("2200", "0030"),
                access_mode=access_mode,
                walking_distance=walking_distance,
                closure_mode=closure_mode,
                information_mode=information_mode,
            ),
            snapshot_events=self.events,
            baseline_covered=self.inputs.baseline_covered,
        )

    @staticmethod
    def _event(stop_id, trip_id, route_id):
        return ActiveStopEvent(
            stop_id=stop_id,
            parent_station="",
            stop_name=stop_id,
            trip_id=trip_id,
            route_id=route_id,
            event_minute=1320,
            lon=-79.4,
            lat=43.7,
        )


if __name__ == "__main__":
    unittest.main()
