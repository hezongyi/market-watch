from datetime import datetime
from decimal import Decimal

import pytest
from alerts import market_data
from alerts.chart_series import encode
from alerts.domain import Candle
from alerts.market import write_bars
from alerts.market_data import QuoteQuery, quote_snapshot
from alerts.storage import Instrument, MarketDemand
from sqlalchemy import select


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def candle(at):
    from alerts.storage import instant

    return Candle(instant(at), instant(at + 60000), *(Decimal("4000") for _ in range(4)))


def test_managed_unknown_never_certifies_old_aggregation_calendar(database, monkeypatch):
    friday = stamp("2026-10-09T20:59:00+00:00")
    monkeypatch.setattr(market_data, "now_ms", lambda: stamp("2026-10-10T12:00:00+00:00"))
    with database.begin() as db:
        inst = db.get(Instrument, "XAUUSD")
        inst.source, inst.symbol = "oanda", "XAU_USD"
        write_bars(db, inst.id, "M1", [candle(friday)])
    row = quote_snapshot(QuoteQuery(symbols=["XAUUSD"]))
    value = row[0]["v"]
    assert value["market_session"] == "unknown"
    assert "时段未核实" in value["description"] and "按日历休市" not in value["description"]
    assert value["data_start"] == friday and value["quote_time"] is None
    assert "最后行情时间 2026-10-09 20:59" in value["description"]
    assert "session_conflict" not in value


def test_managed_closed_and_waiting_are_visible_without_changing_time(database, monkeypatch):
    friday = stamp("2026-10-09T20:59:00+00:00")
    with database.begin() as db:
        inst = db.get(Instrument, "XAUUSD")
        inst.source, inst.symbol = "dukascopy", "xauusd"
        write_bars(db, inst.id, "M1", [candle(friday)])
    monkeypatch.setattr(market_data, "now_ms", lambda: stamp("2026-10-10T12:00:00+00:00"))
    closed = quote_snapshot(QuoteQuery(symbols=["XAUUSD"]))[0]["v"]
    assert "休市 · 周末" in closed["description"] and not closed.get("session_conflict")
    monkeypatch.setattr(market_data, "now_ms", lambda: stamp("2026-10-11T22:30:00+00:00"))
    waiting = quote_snapshot(QuoteQuery(symbols=["XAUUSD"]))[0]["v"]
    assert "交易时段内" in waiting["description"] and "等待新行情" in waiting["description"]
    assert waiting["data_start"] == closed["data_start"] == friday


def test_no_time_has_explicit_unknown_and_no_invented_timestamp(database, monkeypatch):
    monkeypatch.setattr(market_data, "now_ms", lambda: stamp("2026-10-10T12:00:00+00:00"))
    with database.begin() as db:
        inst = db.get(Instrument, "XAUUSD")
        inst.source, inst.symbol = "oanda", "XAU_USD"
    value = quote_snapshot(QuoteQuery(symbols=["XAUUSD"]))[0]["v"]
    assert "暂无行情更新时间" in value["description"] and "时段未核实" in value["description"]
    assert value["quote_time"] is None and value["data_start"] is None and "lp" not in value


def test_first_provider_read_failure_keeps_resolved_session_and_no_price(monkeypatch):
    from alerts import provider_chart

    monkeypatch.setattr(market_data, "now_ms", lambda: stamp("2026-10-10T12:00:00+00:00"))
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: {
        "source": "dukascopy", "symbol": "XAU/USD", "id": "XAUUSD", "name": "Gold", "basis": "bid"})
    def fail(*args, **kwargs):
        raise TimeoutError("Synthetic first read failure")
    monkeypatch.setattr(provider_chart, "quote_page", fail)
    value = quote_snapshot(QuoteQuery(symbols=["MWP:XAUUSD"]))[0]["v"]
    assert value["market_session"] == "closed"
    assert "暂无行情更新时间" in value["description"] and "更新失败，暂无成功行情" in value["description"]
    assert "lp" not in value and value["data_start"] is None


def test_history_and_composite_snapshots_preserve_observation_type_and_demand(database, monkeypatch):
    from alerts.history_artifacts import artifact_tick
    from alerts.storage import CompositeRevision, MarketComposite
    from test_composite_chart import populated

    composite_id, revision_id, seam = populated(database, monkeypatch)
    monkeypatch.setattr("alerts.composite_quotes.now_ms", lambda: 200010000)
    with database() as db:
        parent = db.get(CompositeRevision, revision_id).history_version_id
    while artifact_tick(parent):
        pass
    history, composite = quote_snapshot(QuoteQuery(symbols=[encode(parent, "history"), encode(composite_id, "composite")]))
    assert history["v"]["time_type"] == "fixed_history"
    assert history["v"]["data_start"] is not None and "历史数据时间" in history["v"]["description"]
    assert "固定历史" in history["v"]["description"] and "交易时段内" not in history["v"]["description"]
    value = composite["v"]
    assert value["time_type"] == "composite_snapshot" and value["observation_type"] == "source_m1"
    assert value["quote_time"] is None and value["data_start"] == seam + 540000
    assert "最后更新于" not in value["description"] and "最后行情时间" in value["description"]
    assert value["revision_id"] == revision_id and "market_session" in value
    with database() as db:
        assert db.scalar(select(MarketDemand)) is None
        assert db.get(MarketComposite, composite_id).active_revision_id == revision_id


def test_fixed_history_watchlist_derives_change_from_same_version_closed_daily_close(monkeypatch):
    from alerts.quote_presentation import fixed_snapshot

    latest = {"start": stamp("2026-01-07T12:00:00+00:00"),
        "end": stamp("2026-01-07T12:01:00+00:00"), "close": "1.12000"}
    previous = {"start": stamp("2026-01-05T22:00:00+00:00"),
        "end": stamp("2026-01-06T22:00:00+00:00"), "close": "1.10000",
        "complete": False, "time_closed": True, "coverage_complete": False,
        "source_confirmed": True}
    closing = {**previous, "start": previous["end"] - 60000, "complete": True}
    calls = []

    def page(db, version_id, frame, *, before=None, count=2000):
        calls.append((version_id, frame, before, count))
        return {"bars": [previous] if frame == "D1" else [closing if before is not None else latest]}

    monkeypatch.setattr("alerts.history_artifacts.chart_page", page)
    value = fixed_snapshot(None, "fixed-version", {"frames": ["M1"], "calendar": "ny17"})

    assert value["lp"] == 1.12
    assert value["prev_close_price"] == 1.1
    assert value["ch"] == 0.02
    assert value["chp"] == pytest.approx(100 * 0.02 / 1.1)
    assert calls == [
        ("fixed-version", "M1", None, 1),
        ("fixed-version", "D1", stamp("2026-01-06T22:00:00+00:00"), 1),
        ("fixed-version", "M1", stamp("2026-01-06T22:00:00+00:00"), 1),
    ]


@pytest.mark.parametrize("daily_page", [
    {"bars": [{"end": 1767736800000, "close": "1.10", "time_closed": False,
        "source_confirmed": True}]},
    {"bars": [{"end": 1767736800000, "close": "1.10", "time_closed": True,
        "source_confirmed": False}]},
    {"bars": [{"end": 1767736800001, "close": "1.10", "time_closed": True,
        "source_confirmed": True}]},
    ValueError("D1 该周期产物尚未发布"),
])
def test_fixed_history_keeps_last_price_without_verified_daily_close(monkeypatch, daily_page):
    from alerts.quote_presentation import fixed_snapshot

    latest = {"start": stamp("2026-01-07T12:00:00+00:00"),
        "end": stamp("2026-01-07T12:01:00+00:00"), "close": "1.12000"}

    def page(db, version_id, frame, *, before=None, count=2000):
        if frame == "M1":
            return {"bars": [latest]}
        if isinstance(daily_page, Exception):
            raise daily_page
        return daily_page

    monkeypatch.setattr("alerts.history_artifacts.chart_page", page)
    value = fixed_snapshot(None, "fixed-version", {"frames": ["M1"], "calendar": "ny17"})

    assert value["lp"] == 1.12
    assert all(key not in value for key in ("ch", "chp", "prev_close_price"))


def test_composite_stored_source_conflict_and_failure_follow_same_revision(database, monkeypatch):
    from datetime import UTC

    from alerts.config import settings
    from alerts.storage import (
        CompositeRevision,
        LiveState,
        MarketDataset,
        RealtimeMapping,
    )
    from test_composite_chart import populated

    composite_id, revision_id, seam = populated(database, monkeypatch)
    def iso(value):
        return datetime.fromtimestamp(value / 1000, UTC).isoformat()
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        profile = {"revision": "closure-observation-fixture", "source_session": {
            **{key: target.identity[key] for key in ("source", "channel", "environment", "provider_symbol", "account_scope")},
            "timezone": "UTC", "reviewed_start": iso(0), "reviewed_end": iso(300000000 // 60000 * 60000),
            "applicability": "Synthetic exact source", "evidence_url": "https://example.test/rule"},
            "closures": [{"start": iso(seam - 60000), "end": iso(seam + 660000),
                "reason": "验收暂停", "source": "https://example.test/closure"}]}
        monkeypatch.setattr(settings, "oanda_live_session_profiles", {target.identity["provider_symbol"]: profile})
        state = db.get(LiveState, target.id)
        if state is None:
            state = LiveState(dataset_id=target.id)
            db.add(state)
        state.error = "connection_failed"
    monkeypatch.setattr("alerts.composite_quotes.now_ms", lambda: 200010000)
    row = quote_snapshot(QuoteQuery(symbols=[encode(composite_id, "composite")]))[0]
    value = row["v"]
    assert value["revision_id"] == revision_id and value["data_start"] == seam + 540000
    assert value["session_conflict"] and "时段与行情不一致" in value["description"]
    assert "更新失败，保留上次数据" in value["description"]
    assert value["market_session"] == "scheduled_open"
