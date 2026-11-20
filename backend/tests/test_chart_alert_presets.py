"""Preset reads, date semantics and the existing one-rule M5 execution contract."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from alerts import chart_alert_presets as presets
from alerts.chart_alert_domain import Condition, EvaluationState, Observation, advance
from alerts.chart_alert_presets import PreviousDayQuery, previous_day
from alerts.composite_series import period
from alerts.storage import ChartAlert, CompositeRevision, MarketComposite
from sqlalchemy import func, select, update
from test_composite_alerts import ready_config


def ms(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=UTC).timestamp() * 1000)


def setup_preset(database, monkeypatch, *, now=None, phase="ny17", outside=False):
    config = ready_config(database, monkeypatch)()
    stamp = ms("2026-11-20T15:00:00") if now is None else now
    start, _ = period(stamp, "D1", phase)
    left, right = period(start - 1, "D1", phase)
    calls = []
    with database.begin() as db:
        composite = db.get(MarketComposite, config.instrument)
        revision = db.get(CompositeRevision, composite.active_revision_id)
        revision_id = revision.id
        if phase != revision.rules["aggregation_calendar"]:
            # This isolated date-selection fixture has no real 2026 series.
            db.execute(update(CompositeRevision).where(CompositeRevision.id == revision_id)
                .values(rules={**revision.rules, "aggregation_calendar": phase}))
        # Isolate preset date selection from the short 1970 fixture history.
        profile = {"revision": "test", "closures": []}
        # SOURCE-backed full weekend closures for NY17, including boundaries.
        if phase == "ny17":
            profile["source_session"] = {
                "source": "oanda", "channel": "v20", "environment": "practice",
                "provider_symbol": "EUR_USD", "account_scope": "public",
                "timezone": "America/New_York", "reviewed_start": "2020-01-01T00:00:00Z",
                "reviewed_end": "2030-01-01T00:00:00Z", "evidence_url": "https://example.com/session",
                "applicability": "isolated fixture", "weekly_closures": [{"start": 6780, "end": 9660}],
            }
        monkeypatch.setattr("alerts.price_alert_evaluator.eligibility", lambda *a, **k: None)
        monkeypatch.setattr("alerts.price_alert_close.window_reason", lambda *a, **k: None)
        monkeypatch.setattr("alerts.live_session.effective_profile", lambda *a: profile)
    daily = {"start": left, "end": right, "low": "1.10", "high": "1.12",
             "close": "1.11", "time_closed": True, "source_confirmed": True,
             "complete": False, "mixed_source": False}

    def page(db, instrument, frame, **kwargs):
        calls.append((instrument, frame, kwargs))
        if frame == "D1":
            return {"bars": [daily], "input_revision": 1}
        return {"bars": [{"close": "1.13" if outside else "1.11", "source_confirmed": True}]}

    monkeypatch.setattr(presets, "chart_page", page)
    return config.instrument, revision_id, stamp, daily, calls


def test_preset_is_read_only_and_returns_one_ordinary_rule_fields(database, monkeypatch):
    instrument, revision, stamp, daily, calls = setup_preset(database, monkeypatch, outside=True)
    with database.begin() as db:
        before = db.scalar(select(func.count()).select_from(ChartAlert))
        result = previous_day(db, PreviousDayQuery(instrument=instrument, composite_revision_id=revision), now=stamp)
        assert db.scalar(select(func.count()).select_from(ChartAlert)) == before
    assert result["lower"] == daily["low"] and result["upper"] == daily["high"]
    assert result["expires_at"] == result["day_end"] + 1
    assert result["outside"] is True
    assert [frame for _, frame, _ in calls] == ["D1", "M5"]
    assert all(kw["revision_id"] == revision for _, _, kw in calls)


@pytest.mark.parametrize("change", ["missing", "stale", "unconfirmed", "unfinished", "mixed", "flat"])
def test_missing_or_unusable_reference_never_falls_back(database, monkeypatch, change):
    instrument, revision, stamp, daily, _ = setup_preset(database, monkeypatch)
    if change == "missing":
        monkeypatch.setattr(presets, "chart_page", lambda *a, **k: {"bars": [], "input_revision": 1})
    elif change == "stale":
        daily["start"] -= 86400000
    elif change == "unconfirmed":
        daily["source_confirmed"] = False
    elif change == "unfinished":
        daily["time_closed"] = False
    elif change == "mixed":
        daily["mixed_source"] = True
    else:
        daily["low"] = daily["high"]
    with database.begin() as db, pytest.raises(ValueError):
        previous_day(db, PreviousDayQuery(instrument=instrument, composite_revision_id=revision), now=stamp)


def test_foreign_revision_and_unmapped_instrument_are_rejected(database, monkeypatch):
    instrument, revision, stamp, _, _ = setup_preset(database, monkeypatch)
    with database.begin() as db:
        with pytest.raises(ValueError, match="来源已改变"):
            previous_day(db, PreviousDayQuery(instrument=instrument, composite_revision_id="missing"), now=stamp)
        with pytest.raises(ValueError, match="自建行情"):
            previous_day(db, PreviousDayQuery(instrument="f" * 64), now=stamp)


def test_utc_day_reference_and_cutoff(database, monkeypatch):
    instrument, _, stamp, _, _ = setup_preset(database, monkeypatch, phase="utc0")
    with database.begin() as db:
        result = previous_day(db, PreviousDayQuery(instrument=instrument), now=stamp)
    assert result["reference_start"] == ms("2026-11-19T00:00:00")
    assert result["reference_end"] == ms("2026-11-20T00:00:00")
    assert result["reference_date"] == "2026-11-19"
    assert result["day_end"] == ms("2026-11-21T00:00:00")


@pytest.mark.parametrize("price,direction,threshold", [("111", "exit", "110"), ("99", "exit", "100")])
def test_single_exit_rule_is_once_for_either_confirmed_close(price, direction, threshold):
    condition = Condition.model_validate({"relation": "exit", "lower": "100", "upper": "110"})
    state, first = advance(condition, EvaluationState(), Observation("baseline", 0, 0, Decimal("105")), 1)
    assert first is None
    state, event = advance(condition, state, Observation("m5", 1, 300000, Decimal(price)), 1)
    assert event and event.direction == direction and str(event.threshold) == threshold
    state, event = advance(condition, state, Observation("back", 2, 600000, Decimal("105")), 1)
    assert event is None
    _, event = advance(condition, state, Observation("other", 3, 900000, Decimal("99")), 1)
    assert event is None


def test_already_outside_must_reenter_before_an_exit():
    condition = Condition.model_validate({"relation": "exit", "lower": "100", "upper": "110"})
    state = EvaluationState()
    events = []
    for i, value in enumerate(["112", "113", "109", "99"]):
        state, event = advance(condition, state, Observation(str(i), i, i * 300000, Decimal(value)), 1)
        events.append(event)
    assert events[:3] == [None, None, None]
    assert events[-1] and events[-1].threshold == Decimal("100")


@pytest.mark.parametrize("stamp,expected_start,expected_end,expected_cutoff,date", [
    ("2026-11-23T15:00:00", "2026-11-19T22:00:00", "2026-11-20T22:00:00", "2026-11-23T22:00:00", "2026-11-20"),
    ("2026-07-10T15:00:00", "2026-07-08T21:00:00", "2026-07-09T21:00:00", "2026-07-10T21:00:00", "2026-07-09"),
    ("2026-11-01T23:00:00", "2026-10-29T21:00:00", "2026-10-30T21:00:00", "2026-11-02T22:00:00", "2026-10-30"),
])
def test_weekend_and_dst_use_trading_dates(database, monkeypatch, stamp, expected_start, expected_end, expected_cutoff, date):
    instrument, revision, stamp, daily, _ = setup_preset(database, monkeypatch, now=ms(stamp))
    daily.update(start=ms(expected_start), end=ms(expected_end))
    with database.begin() as db:
        result = previous_day(db, PreviousDayQuery(instrument=instrument), now=stamp)
    assert result["reference_start"] == ms(expected_start)
    assert result["reference_end"] == ms(expected_end)
    assert result["day_end"] == ms(expected_cutoff)
    assert result["reference_date"] == date


def test_holiday_is_skipped_but_query_failure_is_not(database, monkeypatch):
    instrument, _, stamp, daily, _ = setup_preset(database, monkeypatch)
    # Entire Thursday D1 is an explicitly confirmed holiday.
    from alerts.calendar_profile import Profile
    profile = Profile(revision="holiday", closures=[{
        "start": "2026-11-18T22:00:00Z", "end": "2026-11-19T22:00:00Z",
        "reason": "fixture holiday", "source": "https://example.com/holiday",
    }]).model_dump(mode="json")
    monkeypatch.setattr("alerts.live_session.effective_profile", lambda *a: profile)
    daily.update(start=ms("2026-11-17T22:00:00"), end=ms("2026-11-18T22:00:00"))
    with database.begin() as db:
        result = previous_day(db, PreviousDayQuery(instrument=instrument), now=stamp)
        assert result["reference_date"] == "2026-11-18"
    monkeypatch.setattr("alerts.price_alert_close.window_reason", lambda *a, **k: "confirmation_query_failed")
    with database.begin() as db, pytest.raises(ValueError, match="确认查询"):
        previous_day(db, PreviousDayQuery(instrument=instrument), now=stamp)


def test_preset_http_auth_and_no_writes(database, monkeypatch):
    from alerts import api as api_module
    from fastapi.testclient import TestClient
    from test_chart_alert_api import login

    instrument, _, stamp, daily, _ = setup_preset(database, monkeypatch)
    monkeypatch.setattr(presets, "now_ms", lambda: stamp)
    with TestClient(api_module.app) as client:
        url = "/api/chart-alerts/presets/previous-day"
        assert client.post(url, json={"instrument": instrument}).status_code == 401
        login(client, monkeypatch)
        response = client.post(url, json={"instrument": instrument})
        assert response.status_code == 200 and response.json()["lower"] == daily["low"]
        assert client.get("/api/chart-alerts").json() == []
        assert client.post(url, json={"instrument": "EURUSD"}).status_code == 422
