import re
from enum import StrEnum


Schedule = dict[int, list[tuple[int, int]]] | None


class Availability(StrEnum):
    OPEN = "open"
    CLOSED = "closed"
    TEMPORARILY_CLOSED = "temporarily_closed"
    UNKNOWN = "unknown"


DAY_INDEX = {
    "mon": 0,
    "tue": 1,
    "wed": 2,
    "thu": 3,
    "fri": 4,
    "sat": 5,
    "sun": 6,
}


def _parse_clock(raw_time: str) -> int:
    match = re.fullmatch(r"\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*", raw_time)
    if not match:
        raise ValueError(f"Unsupported time: {raw_time!r}")
    hour = int(match.group(1)) % 12
    minute = int(match.group(2) or 0)
    if match.group(3).lower() == "p":
        hour += 12
    return hour * 60 + minute


def _parse_day_selector(raw_selector: str) -> list[int]:
    selector = raw_selector.lower().strip()
    selector = re.sub(r"\s*(?:&|and)\s*holidays?", "", selector)
    if selector in {"weekend", "weekends"}:
        return [5, 6]
    if "-" not in selector:
        key = selector[:3]
        if key not in DAY_INDEX:
            raise ValueError(f"Unsupported day: {raw_selector!r}")
        return [DAY_INDEX[key]]

    start_raw, end_raw = selector.split("-", 1)
    start = DAY_INDEX[start_raw.strip()[:3]]
    end = DAY_INDEX[end_raw.strip()[:3]]
    days = [start]
    while days[-1] != end:
        days.append((days[-1] + 1) % 7)
    return days


def _parse_intervals(raw_intervals: str) -> list[tuple[int, int]]:
    value = raw_intervals.strip()
    if value.lower() == "closed":
        return []

    intervals = []
    for raw_interval in re.split(r"\s*&\s*", value):
        parts = re.split(r"\s+(?:to|until)\s+|\s*-\s*", raw_interval, maxsplit=1)
        if len(parts) != 2:
            raise ValueError(f"Unsupported interval: {raw_interval!r}")
        start = _parse_clock(parts[0])
        end = _parse_clock(parts[1])
        if end <= start:
            end += 24 * 60
        intervals.append((start, end))
    return intervals


def parse_weekly_hours(raw_hours: str) -> Schedule:
    value = (raw_hours or "").strip()
    lowered = value.lower()
    if not value or lowered in {"none", "non-branch row", "centre hours"}:
        return None
    if lowered.startswith("view "):
        return None
    if lowered == "closed":
        return {day: [] for day in range(7)}

    day_prefix = re.compile(
        r"^(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|"
        r"fri(?:day)?|sat(?:urday)?|sun(?:day)?|weekends?)"
        r"(?:\s*-\s*(mon|tue|wed|thu|fri|sat|sun))?"
        r"(?:\s*(?:&|and)\s*holidays?)?\s*:?[ ]+(.*)$",
        re.IGNORECASE,
    )

    if not day_prefix.match(value):
        try:
            intervals = _parse_intervals(value)
        except ValueError:
            return None
        return {day: list(intervals) for day in range(7)}

    segments = re.split(
        r"\s*[;,]\s*(?=(?:mon|tue|wed|thu|fri|sat|sun|weekend))",
        value,
        flags=re.IGNORECASE,
    )
    schedule = {day: [] for day in range(7)}
    try:
        for segment in segments:
            match = day_prefix.match(segment.strip())
            if not match:
                raise ValueError(f"Unsupported schedule segment: {segment!r}")
            selector = match.group(1)
            if match.group(2):
                selector = f"{selector[:3]}-{match.group(2)}"
            intervals = _parse_intervals(match.group(3))
            for day in _parse_day_selector(selector):
                schedule[day].extend(intervals)
    except (KeyError, ValueError):
        return None
    return schedule


def availability_at(
    schedule: Schedule,
    *,
    weekday: int,
    minute: int,
    temporarily_closed: bool = False,
) -> Availability:
    if temporarily_closed:
        return Availability.TEMPORARILY_CLOSED
    if schedule is None:
        return Availability.UNKNOWN

    for start, end in schedule[weekday]:
        if start <= minute < min(end, 24 * 60):
            return Availability.OPEN

    previous_day = (weekday - 1) % 7
    for _start, end in schedule[previous_day]:
        if end > 24 * 60 and minute < end - 24 * 60:
            return Availability.OPEN
    return Availability.CLOSED
