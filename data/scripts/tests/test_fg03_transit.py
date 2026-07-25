import csv
import io
import runpy
import tempfile
import unittest
import zipfile
from dataclasses import FrozenInstanceError
from datetime import date
from pathlib import Path
from unittest.mock import patch

import fg03_transit
from shapely.geometry import box
from fg03_transit import (
    ActiveStopEvent,
    active_stop_events,
    aggregate_catchment,
    gtfs_seconds,
    resolve_service_ids,
)


SERVICE_DATE = date(2026, 7, 21)


def write_gtfs_csv(archive: zipfile.ZipFile, name: str, rows: list[dict[str, str]]):
    content = io.StringIO()
    writer = csv.DictWriter(content, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    archive.writestr(name, content.getvalue())


def create_gtfs_archive(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        write_gtfs_csv(
            archive,
            "calendar.txt",
            [
                {
                    "service_id": "weekday",
                    "monday": "1",
                    "tuesday": "1",
                    "wednesday": "1",
                    "thursday": "1",
                    "friday": "1",
                    "saturday": "0",
                    "sunday": "0",
                    "start_date": "20260101",
                    "end_date": "20261231",
                },
                {
                    "service_id": "removed",
                    "monday": "1",
                    "tuesday": "1",
                    "wednesday": "1",
                    "thursday": "1",
                    "friday": "1",
                    "saturday": "0",
                    "sunday": "0",
                    "start_date": "20260101",
                    "end_date": "20261231",
                },
                {
                    "service_id": "extra",
                    "monday": "0",
                    "tuesday": "0",
                    "wednesday": "0",
                    "thursday": "0",
                    "friday": "0",
                    "saturday": "0",
                    "sunday": "0",
                    "start_date": "20260101",
                    "end_date": "20261231",
                },
            ],
        )
        write_gtfs_csv(
            archive,
            "calendar_dates.txt",
            [
                {"service_id": "extra", "date": "20260721", "exception_type": "1"},
                {"service_id": "removed", "date": "20260721", "exception_type": "2"},
            ],
        )
        write_gtfs_csv(
            archive,
            "trips.txt",
            [
                {"route_id": "501", "service_id": "weekday", "trip_id": "trip-one"},
                {"route_id": "502", "service_id": "extra", "trip_id": "trip-extra"},
                {"route_id": "503", "service_id": "removed", "trip_id": "trip-removed"},
            ],
        )
        write_gtfs_csv(
            archive,
            "stops.txt",
            [
                {
                    "stop_id": "station-a",
                    "stop_name": "Station A",
                    "stop_lat": "43.7000",
                    "stop_lon": "-79.4000",
                    "location_type": "1",
                    "parent_station": "",
                },
                {
                    "stop_id": "stop-a",
                    "stop_name": "Platform A",
                    "stop_lat": "43.7001",
                    "stop_lon": "-79.4001",
                    "location_type": "0",
                    "parent_station": "station-a",
                },
                {
                    "stop_id": "stop-b",
                    "stop_name": "Platform B",
                    "stop_lat": "43.7002",
                    "stop_lon": "-79.4002",
                    "location_type": "0",
                    "parent_station": "station-a",
                },
                {
                    "stop_id": "stop-c",
                    "stop_name": "Street stop C",
                    "stop_lat": "43.7010",
                    "stop_lon": "-79.4010",
                    "location_type": "0",
                    "parent_station": "",
                },
            ],
        )
        write_gtfs_csv(
            archive,
            "stop_times.txt",
            [
                {
                    "trip_id": "trip-one",
                    "arrival_time": "24:30:00",
                    "departure_time": "24:30:00",
                    "stop_id": "stop-a",
                    "stop_sequence": "1",
                },
                {
                    "trip_id": "trip-one",
                    "arrival_time": "24:35:00",
                    "departure_time": "24:35:00",
                    "stop_id": "stop-b",
                    "stop_sequence": "2",
                },
                {
                    "trip_id": "trip-extra",
                    "arrival_time": "24:30:00",
                    "departure_time": "24:30:00",
                    "stop_id": "stop-c",
                    "stop_sequence": "1",
                },
                {
                    "trip_id": "trip-removed",
                    "arrival_time": "24:30:00",
                    "departure_time": "24:30:00",
                    "stop_id": "stop-c",
                    "stop_sequence": "1",
                },
            ],
        )


class TransitActivityTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.gtfs_path = Path(self.temporary_directory.name) / "fixture.zip"
        create_gtfs_archive(self.gtfs_path)
        self.events = [
            ActiveStopEvent(
                stop_id="stop-a",
                parent_station="station-a",
                stop_name="Platform A",
                trip_id="trip-one",
                route_id="501",
                event_minute=1470,
                lon=-79.4001,
                lat=43.7001,
            ),
            ActiveStopEvent(
                stop_id="stop-b",
                parent_station="station-a",
                stop_name="Platform B",
                trip_id="trip-one",
                route_id="501",
                event_minute=1475,
                lon=-79.4002,
                lat=43.7002,
            ),
        ]

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_resolve_service_ids_applies_calendar_and_date_exceptions(self):
        # Protected break: ignoring either exception type schedules cancelled or added service.
        self.assertEqual(resolve_service_ids(self.gtfs_path, SERVICE_DATE), {"weekday", "extra"})

    def test_gtfs_seconds_preserves_times_beyond_midnight(self):
        # Protected break: normalizing 25:05:30 to a same-day time loses the service-day position.
        self.assertEqual(gtfs_seconds("25:05:30"), 90_330)

    def test_after_midnight_snapshot_uses_prior_service_day_minute(self):
        # Protected break: treating 12:30 a.m. as minute 30 excludes its 24:30 GTFS events.
        events = active_stop_events(
            self.gtfs_path,
            SERVICE_DATE,
            snapshot_minute=1470,
            window_minutes=15,
        )

        self.assertEqual({event.stop_id for event in events}, {"stop-a", "stop-b", "stop-c"})
        self.assertEqual({event.trip_id for event in events}, {"trip-one", "trip-extra"})
        self.assertTrue(all(event.event_minute >= 1470 for event in events))

    def test_active_events_keep_platform_metadata_and_are_immutable(self):
        # Protected break: grouping before event creation discards platform metadata and trip context.
        event = next(
            event
            for event in active_stop_events(
                self.gtfs_path,
                SERVICE_DATE,
                snapshot_minute=1470,
                window_minutes=0,
            )
            if event.stop_id == "stop-a"
        )

        self.assertEqual(event.stop_id, "stop-a")
        self.assertEqual(event.parent_station, "station-a")
        self.assertEqual(event.stop_name, "Platform A")
        self.assertEqual(event.trip_id, "trip-one")
        self.assertEqual(event.route_id, "501")
        self.assertEqual((event.lon, event.lat), (-79.4001, 43.7001))
        with self.assertRaises(FrozenInstanceError):
            event.stop_name = "Changed"

    def test_one_trip_stopping_twice_counts_once(self):
        # Protected break: counting rows as trips overstates the activity of multi-stop trips.
        metrics = aggregate_catchment(self.events, {"stop-a", "stop-b"})

        self.assertEqual(metrics.unique_trips, 1)
        self.assertEqual(metrics.unique_routes, 1)
        self.assertEqual(metrics.active_stops, 2)
        self.assertEqual(metrics.stop_time_events, 2)

    def test_missing_required_member_names_the_missing_file(self):
        # Protected break: a raw zip KeyError does not identify the missing GTFS contract member.
        missing_path = Path(self.temporary_directory.name) / "missing.zip"
        with zipfile.ZipFile(missing_path, "w") as archive:
            write_gtfs_csv(
                archive,
                "calendar.txt",
                [
                    {
                        "service_id": "weekday",
                        "monday": "1",
                        "tuesday": "1",
                        "wednesday": "1",
                        "thursday": "1",
                        "friday": "1",
                        "saturday": "0",
                        "sunday": "0",
                        "start_date": "20260101",
                        "end_date": "20261231",
                    }
                ],
            )

        with self.assertRaisesRegex(ValueError, "calendar_dates.txt"):
            resolve_service_ids(missing_path, SERVICE_DATE)

    def test_batch_snapshots_scan_stop_times_once(self):
        # Protected break: scanning once per snapshot decompresses the largest table four times.
        opened_members = []
        original_open = zipfile.ZipFile.open

        def tracking_open(archive, name, *args, **kwargs):
            opened_members.append(name)
            return original_open(archive, name, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "open", new=tracking_open):
            fg03_transit.active_stop_events_for_windows(
                self.gtfs_path,
                SERVICE_DATE,
                windows={
                    "noon": (720, 15),
                    "evening": (1230, 15),
                    "late": (1320, 15),
                    "overnight": (1470, 15),
                },
            )

        self.assertEqual(opened_members.count("stop_times.txt"), 1)

    def test_overlapping_windows_each_receive_matching_event(self):
        # Protected break: first-match partitioning drops events from later overlapping windows.
        events_by_window = fg03_transit.active_stop_events_for_windows(
            self.gtfs_path,
            SERVICE_DATE,
            windows={
                "exact": (1470, 0),
                "overlap": (1475, 5),
            },
        )

        self.assertEqual(
            {event.stop_id for event in events_by_window["exact"]},
            {"stop-a", "stop-c"},
        )
        self.assertEqual(
            {event.stop_id for event in events_by_window["overlap"]},
            {"stop-a", "stop-b", "stop-c"},
        )

    def test_phase_one_builder_scans_stop_times_once_for_all_snapshots(self):
        # Protected break: the Phase 1 adapter can bypass batching and rescan per snapshot.
        builder = runpy.run_path(
            str(Path(__file__).parents[1] / "21_build_washroom_proof.py")
        )
        opened_members = []
        original_open = zipfile.ZipFile.open

        def tracking_open(archive, name, *args, **kwargs):
            opened_members.append(name)
            return original_open(archive, name, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "open", new=tracking_open):
            builder["load_active_transit_stops"](
                self.gtfs_path,
                SERVICE_DATE,
                box(-80, 43, -79, 44),
            )

        self.assertEqual(opened_members.count("stop_times.txt"), 1)


if __name__ == "__main__":
    unittest.main()
