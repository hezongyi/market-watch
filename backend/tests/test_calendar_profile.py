from datetime import UTC, datetime, timedelta
from decimal import Decimal as D

import pytest
from alerts import api as api_module
from alerts.calendar_admin import apply_profile
from alerts.calendar_profile import closures_from, normalized_profile
from alerts.domain import (
    Calendar,
    Candle,
    has_trading_gap,
    previous_session,
    scheduled_open,
    shortened_h4,
)
from alerts.market import ingest, queue_recovery
from alerts.service import (
    add_replay_watch,
    create_watch,
    evaluate_watch,
    previous_day,
    replay_day,
    replay_step,
)
from alerts.storage import Audit, Bar, ImportJob, Instrument, Replay, candle_dict, ms
from sqlalchemy import select


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
        w = create_watch(db, "EURUSD", "guard", {"kind": "price", "level": "10"}, use_history=False)
        changed["revision"] = "test-v2"
        with pytest.raises(ValueError, match="active watches"):
            apply_profile(db, "EURUSD", changed, apply=True)
        w.status = "cancelled"
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


def test_live_and_replay_previous_day_use_snapshot(database):
    start = dt("2026-01-04T22:00:00+00:00")
    day = Candle(start, start + timedelta(days=1), D(9), D(10), D(8), D(9))
    event = Candle(
        dt("2026-01-06T22:00:00+00:00"), dt("2026-01-06T22:05:00+00:00"), D(9), D(11), D(8), D(11)
    )
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.calendar_profile = profile()
        db.add(
            Bar(
                instrument_id=inst.id,
                timeframe="D1",
                start=ms(day.start),
                end=ms(day.end),
                open=day.open,
                high=day.high,
                low=day.low,
                close=day.close,
                complete=True,
            )
        )
        db.flush()
        assert previous_day(db, inst, event).high == D(10)
        assert replay_day([candle_dict(day)], event, "ny17", profile=profile()) == day
        assert replay_day([candle_dict(day)], event, "ny17") is None


def test_shortened_h4_skipped_and_state_reset_in_live_and_replay(database):
    start = datetime(2026, 1, 5, tzinfo=UTC)
    p = profile((start + timedelta(hours=6)).isoformat(), (start + timedelta(hours=8)).isoformat())
    bars = [
        Candle(
            start + timedelta(hours=4 * i),
            start + timedelta(hours=4 * (i + 1)),
            D(v),
            D(v),
            D(v),
            D(v),
        )
        for i, v in enumerate([9, 11, 12])
    ]
    config = {"kind": "price", "timeframe": "H4", "level": "10"}
    assert shortened_h4(bars[1], "H4", closures_from(p))
    assert not shortened_h4(bars[1], "M5", closures_from(p))
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.calendar_profile = p
        for b in bars:
            db.add(
                Bar(
                    instrument_id=inst.id,
                    timeframe="H4",
                    start=ms(b.start),
                    end=ms(b.end),
                    open=b.open,
                    high=b.high,
                    low=b.low,
                    close=b.close,
                    complete=True,
                )
            )
        db.flush()
        watch = create_watch(db, inst.id, "skip", config, armed_at=ms(bars[0].end))
        assert evaluate_watch(db, watch.id) is None
        assert watch.status == "active" and watch.state["previous"]["close"] == "12.0000000000"
        run = Replay(
            instrument_id=inst.id,
            timeframe="H4",
            start=ms(bars[0].end),
            end=ms(bars[-1].end),
            cursor=ms(bars[0].end),
            bars=[candle_dict(b) for b in bars],
            days=[],
            watches=[],
            signals=[],
            calendar_profile=p,
        )
        add_replay_watch(run, "skip", config, "utc0")
        replay_step(run, "utc0", 2)
        assert run.signals == [] and run.watches[0]["status"] == "active"


def test_replay_api_copies_calendar_when_created_and_branched(database):
    start = datetime(2026, 1, 5, tzinfo=UTC)
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.calendar_profile = profile()
        db.add(
            Bar(
                instrument_id=inst.id,
                timeframe="M5",
                start=ms(start),
                end=ms(start) + 300000,
                open=D(10),
                high=D(11),
                low=D(9),
                close=D(10),
                complete=True,
            )
        )
    run = api_module.new_replay(
        api_module.ReplayInput(
            instrument_id="BTCUSDT", timeframe="M5", start=ms(start), end=ms(start) + 300000
        )
    )
    with database.begin() as db:
        db.get(Instrument, "BTCUSDT").calendar_profile = {}
    branch = api_module.seek(run["id"], api_module.SeekInput(cursor=ms(start)))
    assert branch["calendar_profile"] == run["calendar_profile"] == profile()
