import csv
import gzip
import importlib.util
import json
import re
import tempfile
import unittest
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import geopandas as gpd
import networkx as nx
from shapely.geometry import LineString, Point


SCRIPT_PATH = Path(__file__).parents[1] / "22_build_washroom_analysis.py"
SAFE_PLACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


@dataclass(frozen=True)
class AuditCandidateStub:
    candidate_id: str
    audit_status: str = "source review"


def load_builder():
    spec = importlib.util.spec_from_file_location("fg03_phase2_builder", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_csv(path, fieldnames, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


class SyntheticFixture:
    def __init__(self, root):
        self.root = Path(root)
        self.raw = self.root / "raw"
        self.proof = self.root / "proof"
        self.public = self.root / "public"
        self.boundary = self.root / "toronto-boundary.geojson"
        self.topology = self.root / "network-topology-exceptions.csv"
        self.decisions = self.root / "phase2-audit-decisions.csv"
        self.raw.mkdir()
        self.proof.mkdir()
        self._write_network()
        self._write_gtfs()
        self._write_phase1()
        (self.raw / "park-washrooms.csv").write_text("id\n", encoding="utf-8")
        self.boundary.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "properties": {},
                            "geometry": {
                                "type": "Polygon",
                                "coordinates": [[
                                    [-79.42, 43.63],
                                    [-79.36, 43.63],
                                    [-79.36, 43.68],
                                    [-79.42, 43.68],
                                    [-79.42, 43.63],
                                ]],
                            },
                        }
                    ],
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        write_csv(
            self.topology,
            [
                "record_type",
                "first_objectid",
                "second_objectid",
                "x",
                "y",
                "action",
                "reason",
                "reviewer",
                "reviewed_at",
            ],
            [],
        )
        write_csv(
            self.decisions,
            [
                "analysis_hash",
                "candidate_id",
                "audit_status",
                "evidence_note",
                "reviewer",
                "reviewed_at",
            ],
            [],
        )

    def _write_network(self):
        network = gpd.GeoDataFrame(
            [
                {
                    "OBJECTID": 1,
                    "LENGTH": 0.04,
                    "geometry": LineString(
                        [(-79.41, 43.65), (-79.39, 43.65), (-79.37, 43.65)]
                    ),
                },
                {
                    "OBJECTID": 2,
                    "LENGTH": 0.01,
                    "geometry": LineString([(-79.39, 43.65), (-79.39, 43.66)]),
                },
            ],
            geometry="geometry",
            crs="EPSG:4326",
        )
        projected = network.to_crs(2952)
        network["LENGTH"] = projected.geometry.length
        network.to_file(self.raw / "pedestrian-network.gpkg", driver="GPKG")

    def _write_gtfs(self):
        stops = [
            ["s1", "Stop 1", "43.6500", "-79.4000", "p1", "0"],
            ["s2", "Stop 2", "43.6500", "-79.3990", "p1", "0"],
            ["s3", "Stop 3", "43.6500", "-79.3980", "p1", "0"],
            ["p1", "Display Station", "43.6500", "-79.3990", "", "1"],
        ]
        trips = []
        stop_times = []
        for snapshot, value in (
            ("1200", "12:00:00"),
            ("2030", "20:30:00"),
            ("2200", "22:00:00"),
            ("0030", "24:30:00"),
        ):
            for number in range(12):
                trip = (
                    "s1"
                    if snapshot == "1200" and number == 0
                    else f"secret-trip-{snapshot}-{number}"
                )
                trips.append(["r1", "weekday", trip])
                stop_times.append(
                    [trip, value, value, f"s{number % 3 + 1}", "1"]
                )
        files = {
            "calendar.txt": [
                [
                    "service_id",
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                    "start_date",
                    "end_date",
                ],
                ["weekday", "0", "1", "0", "0", "0", "1", "0", "20260701", "20260731"],
            ],
            "calendar_dates.txt": [["service_id", "date", "exception_type"]],
            "routes.txt": [["route_id", "route_short_name"], ["r1", "1"]],
            "trips.txt": [["route_id", "service_id", "trip_id"], *trips],
            "stops.txt": [
                [
                    "stop_id",
                    "stop_name",
                    "stop_lat",
                    "stop_lon",
                    "parent_station",
                    "location_type",
                ],
                *stops,
            ],
            "stop_times.txt": [
                ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
                *stop_times,
            ],
        }
        with zipfile.ZipFile(self.raw / "completegtfs.zip", "w") as archive:
            for name, rows in files.items():
                text = "\n".join(",".join(row) for row in rows) + "\n"
                archive.writestr(name, text)

    def _write_phase1(self):
        facilities = [
            {
                "facility_id": "library:late",
                "source": "library",
                "name": "Late Library",
                "address": "1 Test Street",
                "lon": "-79.4000",
                "lat": "43.6500",
                "hours_raw": "Mon-Sun 9:00am-9:00pm",
                "schedule": "parsed",
                "accessible": "True",
                "all_gender": "",
                "access_condition": "unrestricted",
                "closure_category": "none",
                "temporarily_closed": "False",
                "partial_service": "False",
                "record_count": "1",
                "source_url": "https://example.test/library",
                "notes": "",
                "cluster_id": "1",
                "snap_distance_m": "0",
            },
            {
                "facility_id": "ttc:station",
                "source": "ttc",
                "name": "Station washroom",
                "address": "Station",
                "lon": "-79.3990",
                "lat": "43.6500",
                "hours_raw": "24 hours",
                "schedule": "parsed",
                "accessible": "True",
                "all_gender": "",
                "access_condition": "fare_paid",
                "closure_category": "none",
                "temporarily_closed": "False",
                "partial_service": "False",
                "record_count": "1",
                "source_url": "https://example.test/ttc",
                "notes": "Fare-paid area",
                "cluster_id": "2",
                "snap_distance_m": "0",
            },
        ]
        write_csv(self.proof / "facilities.csv", list(facilities[0]), facilities)
        states = []
        for snapshot in ("1200", "2030", "2200", "0030"):
            states.extend(
                [
                    {
                        "facility_id": "library:late",
                        "snapshot": snapshot,
                        "state": "open" if snapshot in {"1200", "2030"} else "closed",
                    },
                    {
                        "facility_id": "ttc:station",
                        "snapshot": snapshot,
                        "state": "open",
                    },
                ]
            )
        write_csv(
            self.proof / "facility-states.csv",
            ["facility_id", "snapshot", "state"],
            states,
        )
        (self.proof / "summary.json").write_text(
            json.dumps(
                {
                    "snapshot_date": "2026-07-21",
                    "snapshots": [
                        {
                            "slug": snapshot,
                            "open_access_points": 1,
                            "open_facility_records": 1,
                            "fare_paid_open_access_points": 1,
                            "fare_paid_open_facility_records": 1,
                            "active_transit_stops": 100,
                            "covered_transit_stops": 10,
                            "transit_coverage_pct": 10.0,
                        }
                        for snapshot in ("1200", "2030", "2200", "0030")
                    ],
                }
            ),
            encoding="utf-8",
        )

    def build(self, builder, public=None):
        return builder.build_phase2(
            snapshot_date="2026-07-21",
            proof_dir=self.proof,
            raw_dir=self.raw,
            public_dir=public or self.public,
            boundary_path=self.boundary,
            topology_exceptions_path=self.topology,
            audit_decisions_path=self.decisions,
            generated_at=datetime.fromisoformat("2026-07-25T12:00:00-04:00"),
        )


class Phase2BuildContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = SyntheticFixture(self.temporary.name)

    def test_missing_required_input_has_a_coded_actionable_failure(self):
        # Protected break: an opaque file exception does not identify the input
        # contract or the corrective path.
        builder = load_builder()
        (self.fixture.raw / "completegtfs.zip").unlink()

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_INPUT_MISSING.*completegtfs\.zip",
        ):
            self.fixture.build(builder)

    def test_phase1_snapshot_mismatch_is_rejected(self):
        # Protected break: combining proof and raw data from different snapshots
        # makes the dated contract irreproducible.
        builder = load_builder()
        (self.fixture.proof / "summary.json").write_text(
            json.dumps({"snapshot_date": "2026-07-20"}),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_SNAPSHOT_MISMATCH.*2026-07-21.*2026-07-20",
        ):
            self.fixture.build(builder)

    def test_snap_gate_keeps_reachable_stops_but_retains_facility_limit(self):
        # Protected break: applying Phase 1's facility-only 200 metre audit
        # threshold to TTC stops discards valid 300 to 500 metre analyses even
        # though the stop offset is explicitly included in every path.
        builder = load_builder()
        builder._validate_snap_offsets(
            {
                "facility:near": SimpleNamespace(offset_metres=150.0),
                "stop:reachable": SimpleNamespace(offset_metres=295.5),
            }
        )
        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_SNAP_TOO_FAR.*facility:far.*200",
        ):
            builder._validate_snap_offsets(
                {"facility:far": SimpleNamespace(offset_metres=201.0)}
            )

    def test_duplicate_audit_decisions_are_rejected(self):
        builder = load_builder()
        candidate = AuditCandidateStub("candidate:one")
        rows = [
            {
                "analysis_hash": "analysis-hash",
                "candidate_id": candidate.candidate_id,
                "audit_status": "valid",
                "evidence_note": "Source and map agree.",
                "reviewer": "Reviewer",
                "reviewed_at": "2026-07-25",
            },
            {
                "analysis_hash": "analysis-hash",
                "candidate_id": candidate.candidate_id,
                "audit_status": "exclude",
                "evidence_note": "Second decision conflicts.",
                "reviewer": "Reviewer",
                "reviewed_at": "2026-07-25",
            },
        ]
        write_csv(self.fixture.decisions, list(rows[0]), rows)

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_AUDIT_INVALID.*duplicate.*candidate:one",
        ):
            builder._apply_audit_decisions(
                (candidate,),
                (candidate,),
                "analysis-hash",
                self.fixture.decisions,
            )

    def test_resolved_audit_decision_requires_attribution_and_evidence(self):
        builder = load_builder()
        candidate = AuditCandidateStub("candidate:one")
        row = {
            "analysis_hash": "analysis-hash",
            "candidate_id": candidate.candidate_id,
            "audit_status": "valid",
            "evidence_note": " ",
            "reviewer": "\t",
            "reviewed_at": "  ",
        }
        write_csv(self.fixture.decisions, list(row), [row])

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_AUDIT_INVALID.*candidate:one.*evidence_note.*reviewer.*reviewed_at",
        ):
            builder._apply_audit_decisions(
                (candidate,),
                (candidate,),
                "analysis-hash",
                self.fixture.decisions,
            )

    def test_resolved_audit_decision_requires_iso_review_date(self):
        builder = load_builder()
        candidate = AuditCandidateStub("candidate:one")
        row = {
            "analysis_hash": "analysis-hash",
            "candidate_id": candidate.candidate_id,
            "audit_status": "exclude",
            "evidence_note": "The source contradicts the map.",
            "reviewer": "Reviewer",
            "reviewed_at": "July 25, 2026",
        }
        write_csv(self.fixture.decisions, list(row), [row])

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_AUDIT_INVALID.*candidate:one.*ISO",
        ):
            builder._apply_audit_decisions(
                (candidate,),
                (candidate,),
                "analysis-hash",
                self.fixture.decisions,
            )

    def test_valid_attributed_audit_decision_resolves_candidate(self):
        builder = load_builder()
        candidate = AuditCandidateStub("candidate:one")
        row = {
            "analysis_hash": "analysis-hash",
            "candidate_id": candidate.candidate_id,
            "audit_status": "valid",
            "evidence_note": "Source, snap, and map agree.",
            "reviewer": "Reviewer",
            "reviewed_at": "2026-07-25",
        }
        write_csv(self.fixture.decisions, list(row), [row])

        updated, decisions, audit_reason = builder._apply_audit_decisions(
            (candidate,),
            (candidate,),
            "analysis-hash",
            self.fixture.decisions,
        )

        self.assertEqual(updated[0].audit_status, "valid")
        self.assertEqual(decisions[candidate.candidate_id], row)
        self.assertEqual(audit_reason, "")

    def test_pending_audit_decision_remains_incomplete_without_attribution(self):
        builder = load_builder()
        candidate = AuditCandidateStub("candidate:one")
        row = {
            "analysis_hash": "analysis-hash",
            "candidate_id": candidate.candidate_id,
            "audit_status": "source review",
            "evidence_note": "",
            "reviewer": "",
            "reviewed_at": "",
        }
        write_csv(self.fixture.decisions, list(row), [row])

        updated, _decisions, audit_reason = builder._apply_audit_decisions(
            (candidate,),
            (candidate,),
            "analysis-hash",
            self.fixture.decisions,
        )

        self.assertEqual(updated[0].audit_status, "source review")
        self.assertRegex(audit_reason, r"FG03_AUDIT_INCOMPLETE.*candidate:one")

    def test_attributed_stale_audit_decision_is_not_applied(self):
        builder = load_builder()
        candidate = AuditCandidateStub("candidate:one")
        row = {
            "analysis_hash": "old-analysis-hash",
            "candidate_id": candidate.candidate_id,
            "audit_status": "valid",
            "evidence_note": "Source, snap, and map agreed previously.",
            "reviewer": "Reviewer",
            "reviewed_at": "2026-07-25",
        }
        write_csv(self.fixture.decisions, list(row), [row])

        updated, _decisions, audit_reason = builder._apply_audit_decisions(
            (candidate,),
            (candidate,),
            "analysis-hash",
            self.fixture.decisions,
        )

        self.assertEqual(updated[0].audit_status, "source review")
        self.assertRegex(audit_reason, r"FG03_AUDIT_STALE.*candidate:one")

    def test_reach_geometry_does_not_fill_unreachable_middle_of_cycle_edge(self):
        builder = load_builder()
        start = (0.0, 0.0)
        end = (10.0, 0.0)
        source = (5.0, 11.0 ** 0.5)
        graph = nx.Graph()
        graph.add_edge(
            start,
            end,
            length=10.0,
            geometry=LineString([start, end]),
        )
        graph.add_edge(
            source,
            start,
            length=6.0,
            geometry=LineString([source, start]),
        )
        graph.add_edge(
            source,
            end,
            length=6.0,
            geometry=LineString([source, end]),
        )
        engine = SimpleNamespace(
            network=SimpleNamespace(graph=graph),
            candidate_distances=lambda node: nx.single_source_dijkstra_path_length(
                graph,
                node,
                cutoff=500.0,
                weight="length",
            ),
        )

        reach = builder._reach_geometry(
            engine,
            node=source,
            source_offset=0.0,
            walk=7,
        )

        self.assertEqual(len(reach.geoms), 4)
        self.assertAlmostEqual(sum(line.length for line in reach.geoms), 14.0)
        self.assertGreater(reach.distance(Point(5.0, 0.0)), 0.0)

    def test_atomic_publish_restores_previous_output_when_swap_fails(self):
        builder = load_builder()
        destination = self.fixture.root / "published"
        staging = self.fixture.root / "staging"
        destination.mkdir()
        staging.mkdir()
        (destination / "marker.txt").write_text("previous", encoding="utf-8")
        (staging / "marker.txt").write_text("replacement", encoding="utf-8")
        original_rename = Path.rename

        def fail_staging_swap(path, target):
            if path == staging:
                raise OSError("simulated swap failure")
            return original_rename(path, target)

        with patch.object(Path, "rename", fail_staging_swap):
            with self.assertRaisesRegex(OSError, "simulated swap failure"):
                builder._atomic_publish(staging, destination)

        self.assertEqual(
            (destination / "marker.txt").read_text(encoding="utf-8"),
            "previous",
        )
        self.assertTrue(staging.exists())
        self.assertEqual(
            list(destination.parent.glob(f".{destination.name}.backup-*")),
            [],
        )

    def test_proof_publish_failure_preserves_previous_public_contract(self):
        builder = load_builder()
        self.fixture.public.mkdir()
        marker = self.fixture.public / "marker.txt"
        marker.write_text("previous", encoding="utf-8")
        real_atomic_publish = builder._atomic_publish

        def fail_proof_publish(staging, destination):
            if destination == self.fixture.proof / "phase2":
                raise OSError("simulated proof publish failure")
            return real_atomic_publish(staging, destination)

        with patch.object(builder, "_atomic_publish", fail_proof_publish):
            with self.assertRaisesRegex(
                OSError,
                "simulated proof publish failure",
            ):
                self.fixture.build(builder)

        self.assertEqual(
            {path.name for path in self.fixture.public.iterdir()},
            {"marker.txt"},
        )
        self.assertEqual(marker.read_text(encoding="utf-8"), "previous")

    def test_analysis_fingerprint_binds_source_bytes_and_audit_context(self):
        builder = load_builder()
        network_source = self.fixture.root / "network-source"
        network_source.write_bytes(b"first network")
        arguments = {
            "snapshot_date": "2026-07-21",
            "candidate_projections": [{"candidate_id": "candidate:one"}],
            "audit_contexts": [
                {
                    "candidateId": "candidate:one",
                    "canonicalNetworkNode": [1.0, 2.0],
                    "sourceOffsetMetres": 3.0,
                    "gainedStopIds": ["stop:one"],
                    "reach400Sha256": "reach-one",
                }
            ],
            "source_paths": {"pedestrianNetwork": network_source},
        }
        first = builder._analysis_fingerprint(**arguments)

        network_source.write_bytes(b"second network")
        second = builder._analysis_fingerprint(**arguments)
        self.assertNotEqual(first, second)

        changed_context = {
            **arguments,
            "audit_contexts": [
                {
                    **arguments["audit_contexts"][0],
                    "reach400Sha256": "reach-two",
                }
            ],
        }
        third = builder._analysis_fingerprint(**changed_context)
        self.assertNotEqual(second, third)

    def test_public_validator_rejects_camel_case_and_embedded_trip_ids(self):
        builder = load_builder()
        self.fixture.build(builder)
        manifest_path = self.fixture.public / "manifest.json"
        safe_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        unsafe_values = (
            ("effectTripKeys", []),
            ("notes", "trip_id=secret-trip-2200-1"),
            ("url", "tripIds=secret-trip-2200-1&mode=map"),
            ("query", "trip_key=secret-trip-2200-1&mode=map"),
        )

        for key, value in unsafe_values:
            with self.subTest(key=key):
                manifest = json.loads(json.dumps(safe_manifest))
                manifest[key] = value
                manifest_path.write_text(
                    json.dumps(manifest),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    builder.Phase2BuildError,
                    r"FG03_PUBLIC_TRIP_ID_LEAK.*manifest.json",
                ):
                    builder._validate_public(
                        self.fixture.public,
                        {"secret-trip-2200-1"},
                    )

    def test_publication_maps_unsafe_internal_place_ids_consistently(self):
        # Protected break: an audited internal source ID containing spaces or
        # pipes leaks into browser state, URLs, or reach-sidecar joins.
        builder = load_builder()
        unsafe_id = "crem:City Hall|100 Queen Street West"
        expected_public_id = (
            "crem:"
            "862d2f9be72a0f3d9042bd235a5091dd39bd1db64301865c7fa98a17bb128bee"
        )
        facilities_path = self.fixture.proof / "facilities.csv"
        with facilities_path.open(encoding="utf-8") as source:
            facilities = list(csv.DictReader(source))
        facilities[0]["facility_id"] = unsafe_id
        write_csv(facilities_path, list(facilities[0]), facilities)
        states_path = self.fixture.proof / "facility-states.csv"
        with states_path.open(encoding="utf-8") as source:
            states = list(csv.DictReader(source))
        for state in states:
            if state["facility_id"] == "library:late":
                state["facility_id"] = unsafe_id
        write_csv(states_path, list(states[0]), states)

        self.fixture.build(builder)

        facility_features = json.loads(
            (self.fixture.public / "facilities.geojson").read_text()
        )["features"]
        published = next(
            feature
            for feature in facility_features
            if feature["properties"]["name"] == "Late Library"
        )
        self.assertEqual(published["id"], expected_public_id)
        self.assertEqual(published["properties"]["id"], expected_public_id)
        reach_features = json.loads(
            (self.fixture.public / "reach-facilities.geojson").read_text()
        )["features"]
        published_reach = [
            feature
            for feature in reach_features
            if feature["properties"]["placeId"] == expected_public_id
        ]
        self.assertEqual(len(published_reach), 3)
        self.assertEqual(
            {feature["properties"]["walk"] for feature in published_reach},
            {300, 400, 500},
        )
        self.assertEqual(
            {feature["id"] for feature in published_reach},
            {
                f"reach:{expected_public_id}:300",
                f"reach:{expected_public_id}:400",
                f"reach:{expected_public_id}:500",
            },
        )
        for filename in (
            "facilities.geojson",
            "interventions.geojson",
            "reach-facilities.geojson",
            "reach-promoted.geojson",
        ):
            features = json.loads(
                (self.fixture.public / filename).read_text()
            )["features"]
            for feature in features:
                self.assertRegex(str(feature["id"]), SAFE_PLACE_ID)
                for key in ("id", "placeId", "facilityId"):
                    value = feature["properties"].get(key)
                    if value is not None:
                        self.assertRegex(str(value), SAFE_PLACE_ID)

    def test_public_intervention_maps_candidate_and_facility_identities(self):
        # Protected break: an audited intervention maps its feature identity
        # but leaks the unsafe source facility identity through facilityId.
        builder = load_builder()
        internal_facility_id = "crem:City Hall|100 Queen Street West"
        internal_candidate_id = (
            "extend-hours:crem:City Hall|100 Queen Street West"
        )
        public_facility_id = (
            "crem:"
            "862d2f9be72a0f3d9042bd235a5091dd39bd1db64301865c7fa98a17bb128bee"
        )
        public_candidate_id = (
            "extend-hours:"
            "27166b7126a34f28115200ee758383bb421e7c045fb50ad8d4058f2fe81aa5c4"
        )
        candidate = SimpleNamespace(
            candidate_id=internal_candidate_id,
            candidate_class="extend_hours",
            source_stop_id=None,
            facility_id=internal_facility_id,
            lon=-79.38,
            lat=43.65,
            audit_status="valid",
            stability="robust",
        )
        projection = {
            "candidate_id": internal_candidate_id,
            "candidate_class": "extend_hours",
            "verification_kind": None,
            "name": "City Hall extension",
            "facility_id": internal_facility_id,
            "facility": {
                "access_condition": "unrestricted",
                "hours": "Mon-Fri 9:00am-5:00pm",
                "closure_category": "none",
                "accessibility": "accessible",
                "source_url": "https://example.test/city-hall",
            },
            "audit_status": "valid",
            "stability": "robust",
            "material_gain": True,
            "primary_rank": 1,
            "primary_metrics": {},
            "sensitivity_ranks": [],
        }
        engine = SimpleNamespace(
            facility_snaps={
                internal_facility_id: SimpleNamespace(
                    node=(0.0, 0.0),
                    offset_metres=0.0,
                )
            }
        )
        public_place_ids = {
            internal_facility_id: public_facility_id,
            internal_candidate_id: public_candidate_id,
        }

        with (
            patch.object(
                builder,
                "candidate_public_projection",
                return_value=projection,
            ),
            patch.object(builder, "_query_cells", return_value=[]),
        ):
            features, _places = builder._public_interventions(
                (candidate,),
                engine,
                "2026-07-21",
                public_place_ids,
            )

        self.assertEqual(features[0]["id"], public_candidate_id)
        self.assertEqual(
            features[0]["properties"]["id"],
            public_candidate_id,
        )
        self.assertEqual(
            features[0]["properties"]["facilityId"],
            public_facility_id,
        )
        self.assertRegex(features[0]["id"], SAFE_PLACE_ID)
        self.assertRegex(
            features[0]["properties"]["facilityId"],
            SAFE_PLACE_ID,
        )

    def test_publication_rejects_a_generated_place_id_collision(self):
        # Protected break: two different internal identities publish as one
        # browser identity and make selection and reach joins ambiguous.
        builder = load_builder()
        unsafe_id = "crem:City Hall|100 Queen Street West"
        colliding_safe_id = (
            "crem:"
            "862d2f9be72a0f3d9042bd235a5091dd39bd1db64301865c7fa98a17bb128bee"
        )
        facilities_path = self.fixture.proof / "facilities.csv"
        with facilities_path.open(encoding="utf-8") as source:
            facilities = list(csv.DictReader(source))
        facilities[0]["facility_id"] = unsafe_id
        facilities.append(
            {
                **facilities[0],
                "facility_id": colliding_safe_id,
                "name": "Collision fixture",
                "address": "2 Test Street",
                "lon": "-79.3980",
                "cluster_id": "3",
            }
        )
        write_csv(facilities_path, list(facilities[0]), facilities)
        states_path = self.fixture.proof / "facility-states.csv"
        with states_path.open(encoding="utf-8") as source:
            states = list(csv.DictReader(source))
        for state in states:
            if state["facility_id"] == "library:late":
                state["facility_id"] = unsafe_id
        states.extend(
            {
                "facility_id": colliding_safe_id,
                "snapshot": snapshot,
                "state": "open",
            }
            for snapshot in ("1200", "2030", "2200", "0030")
        )
        write_csv(states_path, list(states[0]), states)

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_PUBLIC_ID_COLLISION.*crem:City Hall.*crem:862d",
        ):
            self.fixture.build(builder)

    def test_reach_ids_hash_only_when_a_safe_place_id_would_overflow(self):
        # Protected break: a valid 128-character place ID becomes an invalid
        # feature ID after the readable reach prefix and walk suffix are added.
        builder = load_builder()
        long_safe_id = "x" * 128
        reach_digest = (
            "24da1b81d0b16df6428eee73c69fcb2a"
            "93c76bc6df706f0c6670fe6bfe800464"
        )
        facilities_path = self.fixture.proof / "facilities.csv"
        with facilities_path.open(encoding="utf-8") as source:
            facilities = list(csv.DictReader(source))
        facilities[0]["facility_id"] = long_safe_id
        write_csv(facilities_path, list(facilities[0]), facilities)
        states_path = self.fixture.proof / "facility-states.csv"
        with states_path.open(encoding="utf-8") as source:
            states = list(csv.DictReader(source))
        for state in states:
            if state["facility_id"] == "library:late":
                state["facility_id"] = long_safe_id
        write_csv(states_path, list(states[0]), states)

        try:
            self.fixture.build(builder)
        except builder.Phase2BuildError as error:
            self.fail(f"a valid place ID must remain publishable: {error}")

        facilities = json.loads(
            (self.fixture.public / "facilities.geojson").read_text()
        )["features"]
        published = next(
            feature
            for feature in facilities
            if feature["properties"]["name"] == "Late Library"
        )
        self.assertEqual(published["id"], long_safe_id)
        reaches = json.loads(
            (self.fixture.public / "reach-facilities.geojson").read_text()
        )["features"]
        published_reaches = [
            feature
            for feature in reaches
            if feature["properties"]["placeId"] == long_safe_id
        ]
        self.assertEqual(
            {feature["id"] for feature in published_reaches},
            {
                f"reach:{reach_digest}:300",
                f"reach:{reach_digest}:400",
                f"reach:{reach_digest}:500",
            },
        )
        self.assertEqual(
            {feature["properties"]["placeId"] for feature in published_reaches},
            {long_safe_id},
        )
        for feature in published_reaches:
            self.assertRegex(feature["id"], SAFE_PLACE_ID)

    def test_publication_rejects_a_hashed_reach_id_collision(self):
        # Protected break: a long place ID's hashed reach ID collides with the
        # readable reach ID of a different, already-safe place.
        builder = load_builder()
        long_safe_id = "x" * 128
        colliding_safe_id = (
            "24da1b81d0b16df6428eee73c69fcb2a"
            "93c76bc6df706f0c6670fe6bfe800464"
        )
        facilities_path = self.fixture.proof / "facilities.csv"
        with facilities_path.open(encoding="utf-8") as source:
            facilities = list(csv.DictReader(source))
        facilities[0]["facility_id"] = long_safe_id
        facilities.append(
            {
                **facilities[0],
                "facility_id": colliding_safe_id,
                "name": "Reach collision fixture",
                "address": "2 Test Street",
                "lon": "-79.3980",
                "cluster_id": "3",
            }
        )
        write_csv(facilities_path, list(facilities[0]), facilities)
        states_path = self.fixture.proof / "facility-states.csv"
        with states_path.open(encoding="utf-8") as source:
            states = list(csv.DictReader(source))
        for state in states:
            if state["facility_id"] == "library:late":
                state["facility_id"] = long_safe_id
        states.extend(
            {
                "facility_id": colliding_safe_id,
                "snapshot": snapshot,
                "state": "open",
            }
            for snapshot in ("1200", "2030", "2200", "0030")
        )
        write_csv(states_path, list(states[0]), states)

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_PUBLIC_ID_COLLISION.*reach:",
        ):
            self.fixture.build(builder)

    def test_public_validator_rejects_feature_and_property_id_drift(self):
        # Protected break: the browser selects a feature by one ID while its
        # details and reach lookup advertise another.
        builder = load_builder()
        self.fixture.build(builder)
        facilities_path = self.fixture.public / "facilities.geojson"
        facilities = json.loads(facilities_path.read_text())
        facilities["features"][0]["id"] = "facility:mismatched"
        facilities_path.write_text(json.dumps(facilities), encoding="utf-8")

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_CONTRACT_INVALID.*feature\.id.*properties\.id",
        ):
            builder._validate_public(
                self.fixture.public,
                {"secret-trip-2200-1"},
            )

    def test_public_validator_rejects_reach_identity_drift(self):
        # Protected break: a sidecar feature can advertise the correct place
        # but carry an unrelated feature ID, breaking map source updates.
        builder = load_builder()
        self.fixture.build(builder)
        reaches_path = self.fixture.public / "reach-facilities.geojson"
        reaches = json.loads(reaches_path.read_text())
        reaches["features"][0]["id"] = "reach:mismatched:300"
        reaches_path.write_text(json.dumps(reaches), encoding="utf-8")

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_CONTRACT_INVALID.*reach feature.*placeId.*walk",
        ):
            builder._validate_public(
                self.fixture.public,
                {"secret-trip-2200-1"},
            )

    def test_public_validator_rejects_ids_outside_exact_safe_contract(self):
        # Protected break: a future serializer adds a whitespace, slash, pipe,
        # or overlong ID that Task 5 correctly refuses to load from the URL.
        builder = load_builder()
        self.fixture.build(builder)
        facilities_path = self.fixture.public / "facilities.geojson"
        facilities = json.loads(facilities_path.read_text())
        facilities["features"][0]["id"] = "unsafe place|one"
        facilities["features"][0]["properties"]["id"] = "unsafe place|one"
        facilities_path.write_text(json.dumps(facilities), encoding="utf-8")

        with self.assertRaisesRegex(
            builder.Phase2BuildError,
            r"FG03_CONTRACT_INVALID.*exact public place ID contract",
        ):
            builder._validate_public(
                self.fixture.public,
                {"secret-trip-2200-1"},
            )

    def test_fixed_clock_build_is_deterministic_and_satisfies_public_contract(self):
        # Protected break: timestamps, unstable iteration, schema drift, leaked
        # trip IDs, or wrong URL assembly changes browser-visible bytes.
        builder = load_builder()
        first = self.fixture.root / "public-first"
        second = self.fixture.root / "public-second"

        self.fixture.build(builder, first)
        self.fixture.build(builder, second)

        required = {
            "manifest.json",
            "facilities.geojson",
            "interventions.geojson",
            "reach-facilities.geojson",
            "reach-promoted.geojson",
            "stops-1200.geojson",
            "stops-2030.geojson",
            "stops-2200.geojson",
            "stops-0030.geojson",
        }
        self.assertEqual({path.name for path in first.iterdir()}, required)
        for filename in sorted(required):
            left = (first / filename).read_bytes()
            right = (second / filename).read_bytes()
            self.assertEqual(left, right, filename)
            self.assertLessEqual(
                len(gzip.compress(left, compresslevel=9, mtime=0)),
                1_500_000,
            )
            self.assertNotIn(b"secret-trip-", left)

        manifest = json.loads((first / "manifest.json").read_text())
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["snapshotDate"], "2026-07-21")
        self.assertEqual(
            manifest["generatedAt"],
            "2026-07-25T12:00:00-04:00",
        )
        self.assertEqual(
            manifest["defaultState"],
            {"time": "2200", "access": "public", "walk": 400, "action": "extend"},
        )
        self.assertEqual(
            manifest["actions"],
            ["open", "extend", "new", "verify", "retrofit"],
        )
        self.assertEqual(
            manifest["allowedValues"]["action"],
            ["open", "extend", "new", "verify", "retrofit"],
        )
        self.assertNotIn(str(self.fixture.root), manifest["gate"]["reason"])
        for snapshot_id, headline in manifest["headlines"]["bySnapshot"].items():
            self.assertEqual(
                set(headline),
                {
                    "phase1Grouped",
                    "phase2GtfsStops",
                },
            )
            phase1 = headline["phase1Grouped"]
            self.assertEqual(
                set(phase1),
                {
                    "unit",
                    "unrestrictedOpenAccessPointCount",
                    "unrestrictedOpenFacilityRecordCount",
                    "farePaidOpenAccessPointCount",
                    "farePaidOpenFacilityRecordCount",
                    "activeTransitPointCount",
                    "unrestrictedCoveredTransitPointCount",
                    "unrestrictedCoveragePercent",
                },
            )
            self.assertEqual(phase1["unit"], "grouped transit points")
            self.assertEqual(phase1["activeTransitPointCount"], 100)
            self.assertEqual(phase1["unrestrictedCoveredTransitPointCount"], 10)
            self.assertEqual(phase1["unrestrictedCoveragePercent"], 10.0)
            phase2 = headline["phase2GtfsStops"]
            self.assertEqual(
                set(phase2),
                {
                    "unit",
                    "activeStopCount",
                    "eventCount",
                    "unrestrictedCoveredStopCount",
                    "uniqueTripCount",
                },
            )
            self.assertEqual(phase2["unit"], "GTFS stops and platforms")
            self.assertLessEqual(
                phase2["unrestrictedCoveredStopCount"],
                phase2["activeStopCount"],
            )
            stop_features = json.loads(
                (first / f"stops-{snapshot_id}.geojson").read_text()
            )["features"]
            self.assertEqual(phase2["activeStopCount"], len(stop_features))
            self.assertEqual(
                phase2["eventCount"],
                sum(item["properties"]["eventCount"] for item in stop_features),
            )
            self.assertEqual(
                phase2["unrestrictedCoveredStopCount"],
                sum(
                    item["properties"]["coverage"]["public"]["400"]
                    for item in stop_features
                ),
            )
        report = self.fixture.proof / "phase2" / "build-report.json"
        diagnostics = json.loads(report.read_text())["snaps"]
        self.assertEqual(set(diagnostics), {"facilities", "stops"})
        for values in diagnostics.values():
            self.assertEqual(
                set(values),
                {"count", "p50Metres", "p95Metres", "p99Metres", "maxMetres", "over200Metres"},
            )
        for url in manifest["files"].values():
            self.assertTrue(url.startswith("/data/fg03/2026-07-21/"), url)
            self.assertNotIn("..", url)
            self.assertNotIn("?", url)

        facilities = json.loads((first / "facilities.geojson").read_text())
        self.assertEqual(facilities["type"], "FeatureCollection")
        self.assertEqual(
            {feature["geometry"]["type"] for feature in facilities["features"]},
            {"Point"},
        )
        for feature in facilities["features"]:
            self.assertEqual(set(feature["properties"]["stateByTime"]), {
                "1200",
                "2030",
                "2200",
                "0030",
            })
        self.assertEqual(
            [
                feature["properties"]["id"]
                for feature in facilities["features"]
                if feature["properties"]["accessCondition"] == "fare_paid"
            ],
            ["ttc:station"],
        )
        facility_reaches = json.loads(
            (first / "reach-facilities.geojson").read_text()
        )["features"]
        self.assertTrue(
            any(
                feature["properties"]["accessCondition"] == "fare_paid"
                for feature in facility_reaches
            )
        )

        public_stops = json.loads((first / "stops-2200.geojson").read_text())
        for feature in public_stops["features"]:
            self.assertEqual(
                feature["properties"]["parentStation"],
                "Display Station",
            )
            coverage = feature["properties"]["coverage"]
            self.assertLessEqual(
                coverage["public"]["400"],
                coverage["rider_conditional"]["400"],
            )
            for access in ("public", "rider_conditional"):
                self.assertLessEqual(
                    coverage[access]["300"],
                    coverage[access]["400"],
                )
                self.assertLessEqual(
                    coverage[access]["400"],
                    coverage[access]["500"],
                )


if __name__ == "__main__":
    unittest.main()
