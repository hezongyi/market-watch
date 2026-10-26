from datetime import datetime
from decimal import Decimal as D

import pytest
from alerts.calendar_admin import apply_profile
from alerts.calendar_profile import closures_from, normalized_profile
from alerts.chart_alert_service import create
from alerts.domain import (
    Calendar,
    Candle,
    has_trading_gap,
    previous_session,
    scheduled_open,
    shortened_h4,
)
from alerts.market import ingest, queue_recovery
from alerts.storage import Audit, ImportJob, Instrument, ms
from sqlalchemy import select
from test_chart_alert_service import config


def dt(value):
    return datetime.fromisoformat(value)


def profile(start="2026-01-05T22:00:00+00:00", end="2026-01-06T22:00:00+00:00"):
    # Synthetic test fixture, not an assertion about any real provider's holiday.
    return {
        "revision": "test-v1",
        "closures": [
            {
                "start": start,
                "end": end,
                "reason": "synthetic closure",
                "source": "https://example.test/calendar",
            }
        ],
    }


def test_confirmed_full_session_skips_but_missing_session_does_not():
    when = dt("2026-01-07T12:00:00+00:00")
    closed = closures_from(profile())
    assert previous_session(when, Calendar.NY17)[0] == dt("2026-01-05T22:00:00+00:00")
    assert previous_session(when, Calendar.NY17, closures=closed)[0] == dt(
        "2026-01-04T22:00:00+00:00"
    )
    assert not scheduled_open(closed[0].start, Calendar.NY17, closures=closed)
    assert scheduled_open(closed[0].end, Calendar.NY17, closures=closed)
    assert not has_trading_gap(closed[0].start, closed[0].end, Calendar.NY17, closures=closed)
    assert has_trading_gap(closed[0].start, closed[0].end, Calendar.NY17)


def test_partial_session_remains_previous_day_and_timezone_normalizes():
    p = profile("2026-07-07T12:00:00-04:00", "2026-07-07T17:00:00-04:00")
    value = normalized_profile(p)
    assert value["closures"][0]["start"] == "2026-07-07T16:00:00+00:00"
    left, right = previous_session(
        dt("2026-07-08T12:00:00+00:00"), Calendar.NY17, closures=closures_from(p)
    )
    assert left == dt("2026-07-06T21:00:00+00:00")
    assert right == dt("2026-07-07T21:00:00+00:00")


@pytest.mark.parametrize(
    "change",
    [
        {"start": "2026-01-05T22:00:00"},
        {"end": "2026-01-05T21:00:00+00:00"},
        {"start": "2026-01-05T22:00:01+00:00"},
        {"source": "guess"},
    ],
)
def test_invalid_profiles_rejected(change):
    p = profile()
    p["closures"][0].update(change)
    with pytest.raises(ValueError):
        normalized_profile(p)


def test_overlap_rejected():
    p = profile()
    p["closures"] *= 2
    with pytest.raises(ValueError, match="overlap"):
        normalized_profile(p)


def test_admin_preview_apply_and_conflict_guards(database):
    with database.begin() as db:
        assert apply_profile(db, "EURUSD", profile())["applied"] is False
        assert db.get(Instrument, "EURUSD").calendar_profile == {}
        assert apply_profile(db, "EURUSD", profile(), apply=True)["applied"]
        assert db.scalar(select(Audit).where(Audit.kind == "calendar_profile_changed"))
        assert db.scalar(select(ImportJob)).priority == 0
        assert not apply_profile(db, "EURUSD", profile(), apply=True)["changed"]
        changed = profile(end="2026-01-06T23:00:00+00:00")
        with pytest.raises(ValueError, match="revision"):
            apply_profile(db, "EURUSD", changed, apply=True)
        w = create(db, "calendar-guard", config())
        changed["revision"] = "test-v2"
        with pytest.raises(ValueError, match="active ChartAlerts"):
            apply_profile(db, "EURUSD", changed, apply=True)
        w.status = "paused"
        db.flush()
        raw = {
            "rows": [
                {
                    "timestamp": ms(dt(profile()["closures"][0]["start"])),
                    "open": 10,
                    "high": 11,
                    "low": 9,
                    "close": 10,
                }
            ]
        }
        with pytest.raises(ValueError, match="休市区间冲突"):
            ingest(db, db.get(Instrument, "EURUSD"), raw)


def test_no_repair_queued_for_confirmed_closed_empty_window(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.calendar_profile = profile()
        c = closures_from(profile())[0]
        queue_recovery(
            db,
            inst,
            {"rows": [], "window_start": ms(c.start), "window_end": ms(c.end)},
            received_at=ms(c.end) + 5000,
        )
        assert db.scalar(select(ImportJob)) is None








def test_maintenance_explains_gap_without_shortening_h4():
    p = profile("2026-07-06T21:00:00+00:00", "2026-07-06T22:04:00+00:00")
    legacy = normalized_profile(p)
    bar = Candle(
        dt("2026-07-06T21:00:00+00:00"),
        dt("2026-07-07T01:00:00+00:00"),
        D("10"),
        D("12"),
        D("9"),
        D("11"),
    )
    assert shortened_h4(bar, "H4", closures_from(legacy))
    p["closures"][0]["kind"] = "maintenance"
    normalized = normalized_profile(p)
    assert normalized["closures"][0]["kind"] == "maintenance"
    closures = closures_from(normalized)
    assert not shortened_h4(bar, "H4", closures)
    assert not has_trading_gap(closures[0].start, closures[0].end, Calendar.NY17, closures=closures)
    assert normalized_profile(legacy) == legacy
