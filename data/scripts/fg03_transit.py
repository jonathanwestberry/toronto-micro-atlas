"""Shared GTFS service-day activity helpers for Field Guide 03."""

import csv
import io
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ActiveStopEvent:
    """A scheduled stop-time event before station or catchment grouping."""

    stop_id: str
    parent_station: str
    stop_name: str
    trip_id: str
    route_id: str
    event_minute: int
    lon: float
    lat: float


@dataclass(frozen=True, slots=True)
class ActivityMetrics:
    """Catchment activity counts derived from the immutable stop-time events."""

    unique_trips: int
    unique_routes: int
    active_stops: int
    stop_time_events: int


def _read_gtfs_table(
    archive: zipfile.ZipFile, filename: str
) -> list[dict[str, str]]:
    if filename not in archive.namelist():
        raise ValueError(f"GTFS archive missing required member: {filename}")
    with archive.open(filename) as raw:
        return list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig")))


def gtfs_seconds(raw_time: str) -> int:
    """Convert a GTFS HH:MM:SS value without wrapping times beyond midnight."""
    hours, minutes, seconds = (int(value) for value in raw_time.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def resolve_service_ids(gtfs_path: Path, service_date: date) -> set[str]:
    """Return service IDs active on a GTFS service date, including exceptions."""
    with zipfile.ZipFile(gtfs_path) as archive:
        calendar = _read_gtfs_table(archive, "calendar.txt")
        calendar_dates = _read_gtfs_table(archive, "calendar_dates.txt")

    weekday = service_date.strftime("%A").lower()
    ymd = service_date.strftime("%Y%m%d")
    active = {
        row["service_id"]
        for row in calendar
        if row[weekday] == "1" and row["start_date"] <= ymd <= row["end_date"]
    }
    for row in calendar_dates:
        if row["date"] != ymd:
            continue
        if row["exception_type"] == "1":
            active.add(row["service_id"])
        elif row["exception_type"] == "2":
            active.discard(row["service_id"])
    return active


def active_stop_events(
    gtfs_path: Path,
    service_date: date,
    *,
    snapshot_minute: int,
    window_minutes: int,
) -> list[ActiveStopEvent]:
    """Load scheduled platform events near a minute on the supplied service day."""
    return active_stop_events_for_windows(
        gtfs_path,
        service_date,
        windows={"snapshot": (snapshot_minute, window_minutes)},
    )["snapshot"]


def active_stop_events_for_windows(
    gtfs_path: Path,
    service_date: date,
    *,
    windows: dict[str, tuple[int, int]],
) -> dict[str, list[ActiveStopEvent]]:
    """Load scheduled platform events for multiple service-day windows."""
    active_services = resolve_service_ids(gtfs_path, service_date)
    windows_in_seconds = {
        key: (snapshot_minute * 60, window_minutes * 60)
        for key, (snapshot_minute, window_minutes) in windows.items()
    }
    events_by_window = {key: [] for key in windows}

    with zipfile.ZipFile(gtfs_path) as archive:
        trips = _read_gtfs_table(archive, "trips.txt")
        stops = _read_gtfs_table(archive, "stops.txt")
        route_by_trip = {
            row["trip_id"]: row["route_id"]
            for row in trips
            if row["service_id"] in active_services
        }
        stop_by_id = {row["stop_id"]: row for row in stops}
        if "stop_times.txt" not in archive.namelist():
            raise ValueError("GTFS archive missing required member: stop_times.txt")
        with archive.open("stop_times.txt") as raw:
            stop_times = csv.DictReader(
                io.TextIOWrapper(raw, encoding="utf-8-sig")
            )
            for row in stop_times:
                trip_id = row["trip_id"]
                if trip_id not in route_by_trip:
                    continue
                raw_time = row.get("departure_time") or row.get("arrival_time")
                if not raw_time:
                    continue
                event_seconds = gtfs_seconds(raw_time)
                matching_windows = [
                    key
                    for key, (snapshot_seconds, window_seconds) in (
                        windows_in_seconds.items()
                    )
                    if abs(event_seconds - snapshot_seconds) <= window_seconds
                ]
                if not matching_windows:
                    continue
                stop = stop_by_id.get(row["stop_id"])
                if stop is None:
                    continue
                event = ActiveStopEvent(
                    stop_id=stop["stop_id"],
                    parent_station=stop.get("parent_station") or "",
                    stop_name=stop["stop_name"],
                    trip_id=trip_id,
                    route_id=route_by_trip[trip_id],
                    event_minute=event_seconds // 60,
                    lon=float(stop["stop_lon"]),
                    lat=float(stop["stop_lat"]),
                )
                for key in matching_windows:
                    events_by_window[key].append(event)

    sort_key = lambda event: (event.trip_id, event.event_minute, event.stop_id)
    return {
        key: sorted(events, key=sort_key)
        for key, events in events_by_window.items()
    }


def aggregate_catchment(
    events: list[ActiveStopEvent], stop_ids: set[str]
) -> ActivityMetrics:
    """Count stop-time activity at selected stops without duplicating trips."""
    catchment_events = [event for event in events if event.stop_id in stop_ids]
    return ActivityMetrics(
        unique_trips=len({event.trip_id for event in catchment_events}),
        unique_routes=len({event.route_id for event in catchment_events}),
        active_stops=len({event.stop_id for event in catchment_events}),
        stop_time_events=len(catchment_events),
    )
