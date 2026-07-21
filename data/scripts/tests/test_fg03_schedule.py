import unittest

from fg03_schedule import Availability, availability_at, parse_weekly_hours


class ScheduleParsingTests(unittest.TestCase):
    def test_daily_hours_apply_to_every_day(self):
        schedule = parse_weekly_hours("9 a.m. to 10 p.m.")

        self.assertEqual(
            availability_at(schedule, weekday=1, minute=12 * 60),
            Availability.OPEN,
        )
        self.assertEqual(
            availability_at(schedule, weekday=1, minute=22 * 60),
            Availability.CLOSED,
        )

    def test_weekly_schedule_supports_ranges_and_closed_days(self):
        schedule = parse_weekly_hours(
            "Mon-Fri 8:30am-4:30pm, Sat 5:00am-4:00pm, Sun Closed"
        )

        self.assertEqual(
            availability_at(schedule, weekday=1, minute=9 * 60),
            Availability.OPEN,
        )
        self.assertEqual(
            availability_at(schedule, weekday=6, minute=9 * 60),
            Availability.CLOSED,
        )

    def test_holiday_suffix_does_not_hide_weekend_hours(self):
        schedule = parse_weekly_hours(
            "Mon-Fri 7:30am-9:30pm, Sat-Sun & Holidays 8:00am-6:00pm"
        )

        self.assertEqual(
            availability_at(schedule, weekday=5, minute=9 * 60),
            Availability.OPEN,
        )

    def test_multiple_windows_preserve_midday_closure(self):
        schedule = parse_weekly_hours(
            "Mon Closed; Tue 12:30 p.m. to 5 p.m. & 6 p.m. to 8:30 p.m.; "
            "Wed 9 a.m. to 12 p.m. & 1 p.m. to 5 p.m.; Thu Closed; "
            "Fri Closed; Sat Closed; Sun Closed"
        )

        self.assertEqual(
            availability_at(schedule, weekday=1, minute=17 * 60 + 30),
            Availability.CLOSED,
        )
        self.assertEqual(
            availability_at(schedule, weekday=1, minute=18 * 60 + 15),
            Availability.OPEN,
        )

    def test_overnight_interval_carries_into_next_day(self):
        schedule = parse_weekly_hours("Mon-Sun 5:30am-12:45am")

        self.assertEqual(
            availability_at(schedule, weekday=2, minute=30),
            Availability.OPEN,
        )
        self.assertEqual(
            availability_at(schedule, weekday=2, minute=60),
            Availability.CLOSED,
        )

    def test_unpublished_hours_stay_unknown(self):
        schedule = parse_weekly_hours("View outdoor pool hours")

        self.assertEqual(
            availability_at(schedule, weekday=1, minute=12 * 60),
            Availability.UNKNOWN,
        )

    def test_temporary_closure_overrides_published_hours(self):
        schedule = parse_weekly_hours("9 a.m. to 10 p.m.")

        self.assertEqual(
            availability_at(
                schedule,
                weekday=1,
                minute=12 * 60,
                temporarily_closed=True,
            ),
            Availability.TEMPORARILY_CLOSED,
        )


if __name__ == "__main__":
    unittest.main()
