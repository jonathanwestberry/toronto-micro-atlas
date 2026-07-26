import csv
import gzip
import importlib.util
import json
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
