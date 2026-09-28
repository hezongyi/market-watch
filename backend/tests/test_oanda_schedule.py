"""Run with the optional calendar extra installed."""

import importlib.util
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from alerts.calendar_profile import closures_from
from alerts.domain import Calendar, Candle, scheduled_open, shortened_h4

pytest.importorskip("pandas_market_calendars")
spec = importlib.util.spec_from_file_location(
    "oanda_schedule", Path(__file__).resolve().parents[2] / "scripts/oanda_schedule.py"
)
schedule = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schedule)


def dt(value):
    return datetime.fromisoformat(value)


def test_maintenance_dst_boundary_and_h4_preservation():
    profile = schedule.maintenance_profile("2026-03-06", "2026-03-09", revision="test")
    closures = closures_from(profile)
    assert len(closures) == 2  # Friday and Monday labels, no weekend sessions.
    assert closures[0].end == dt("2026-03-05T23:04:00+00:00")
    assert closures[1].end == dt("2026-03-08T22:04:00+00:00")
    assert not scheduled_open(
        dt("2026-03-08T22:03:00+00:00"), Calendar.NY17, gold=True, closures=closures
    )
    assert scheduled_open(closures[1].end, Calendar.NY17, gold=True, closures=closures)
    bar = Candle(
        dt("2026-03-08T21:00:00+00:00"), dt("2026-03-09T01:00:00+00:00"),
        *[Decimal("1")] * 4,
    )
    assert not shortened_h4(bar, "H4", closures)
    assert schedule.maintenance_profile(
        "2026-03-06", "2026-03-09", revision="test", existing=profile
    ) == profile


def test_verified_holiday_takes_precedence_over_maintenance():
    existing = {"revision": "holiday", "closures": [{
        "start": "2026-04-02T17:00:00-04:00",
        "end": "2026-04-03T17:00:00-04:00",
        "source": schedule.HOLIDAYS, "reason": "Good Friday",
    }]}
    profile = schedule.maintenance_profile(
        "2026-04-02", "2026-04-06", revision="merged", existing=existing
    )
    closures = closures_from(profile)
    assert len(closures) == 3
    assert [c.kind for c in closures] == ["maintenance", "holiday", "maintenance"]
    assert existing["revision"] == "holiday"  # Do not mutate the replay/source profile.


@pytest.mark.parametrize("start,end", [
    ("2026-04-03", "2026-04-01"), ("2026-01-01", "2028-01-01"),
])
def test_reject_invalid_generation_range(start, end):
    with pytest.raises(ValueError, match="ordered range"):
        schedule.maintenance_profile(start, end, revision="invalid")
