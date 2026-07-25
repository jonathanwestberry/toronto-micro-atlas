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
