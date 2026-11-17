"""Watch quotes must read published native history without inventing M1 data."""

import pytest
from alerts.chart_series import encode
from alerts.market_data import QuoteQuery, quote_snapshot
from alerts.quote_presentation import fixed_snapshot
from alerts.storage import HistoryChunk, MarketDemand
from sqlalchemy import select
from test_native_history_archive import Adapter, day, prepare, run


@pytest.mark.parametrize("mode", ["base_d1", "native_periods"])
def test_watch_quote_keeps_native_daily_identity_price_and_previous_close(database, mode):
    dataset = prepare(database, mode=mode, outputs=("D1",))
    version = run(database, dataset, "2024-01-09", Adapter({"D1": [
        day("2024-01-05", close="11"),
        day("2024-01-08", close="12"),
    ]}))
    ticker = encode(version, "history")
    quote = quote_snapshot(QuoteQuery(symbols=[ticker]))[0]
    assert quote["s"] == "ok", quote
    assert quote["n"] == ticker
    value = quote["v"]
    assert value["short_name"] == "000001"
    assert "自建" in value["description"] and "fixture" in value["description"]
    assert value["lp"] == 12
    assert value["prev_close_price"] == 11
    assert value["ch"] == 1
    assert value["chp"] == pytest.approx(100 / 11)
    assert value["time_type"] == "fixed_history" and value["resolution"] == "D1"
    assert value["version_id"] == version and value["quote_time"] is None
    # The same quote reader also runs in the separate market worker. A healthy
    # HTTP snapshot alone must not hide a broken SSE result overwriting it.
    from alerts import market_stream as stream
    from alerts.chart_query import DataQuery
    from alerts.market_stream_api import Subscription, resolve
    from alerts.market_stream_worker import Calculator
    from test_market_stream import session

    owner = session(database)
    identity, query = resolve(Subscription(client="watch-native", listener="row",
        generation=1, kind="quotes", query=DataQuery(
            instrument=version, series_kind="history", timeframe="M1")))
    stream.register(owner, "watch-native", "row", 1, identity, query, {})
    work = stream.claim()
    payload, delay = Calculator().build(work)
    stream.commit(work, payload, delay_ms=delay)
    event = stream.events(owner, "watch-native", {})[0]
    assert event["type"] == "quotes"
    assert event["quotes"][0]["s"] == "ok"
    assert event["quotes"][0]["v"] == value
    with database() as db:
        assert db.scalar(select(HistoryChunk).where(HistoryChunk.timeframe == "M1")) is None
        assert db.scalar(select(MarketDemand)) is None


@pytest.mark.parametrize("previous", [None, "unconfirmed", "incomplete", "open", "zero"])
def test_native_daily_missing_close_keeps_price_without_change(monkeypatch, previous):
    latest = {"start": 1704672000000, "end": 1704758400000, "close": "12"}
    daily = {"start": 1704412800000, "end": 1704499200000,
        "close": "0" if previous == "zero" else "11", "complete": previous != "incomplete",
        "source_confirmed": previous != "unconfirmed", "time_closed": previous != "open"}
    calls = []

    def page(db, ident, frame, *, before=None, count=1):
        calls.append((frame, before))
        assert frame == "D1", "Native daily prices do not depend on M1 artifacts"
        return {"bars": ([daily] if previous else []) if before is not None else [latest]}

    monkeypatch.setattr("alerts.history_artifacts.chart_page", page)
    value = fixed_snapshot(None, "native-fixed", {"frames": ["D1"], "calendar": "source_date"})
    assert value["lp"] == 12
    assert not {"ch", "chp", "prev_close_price"} & value.keys()
    assert calls == [("D1", None), ("D1", latest["start"])]


def test_native_weekly_only_quote_does_not_invent_daily_change(monkeypatch):
    calls = []

    def page(db, ident, frame, **kwargs):
        calls.append(frame)
        assert frame == "W1"
        return {"bars": [{"start": 1704672000000, "end": 1705276800000, "close": "12"}]}

    monkeypatch.setattr("alerts.history_artifacts.chart_page", page)
    value = fixed_snapshot(None, "weekly-fixed", {"frames": ["W1"], "calendar": "source_date"})
    assert value["lp"] == 12 and value["resolution"] == "W1"
    assert not {"ch", "chp", "prev_close_price"} & value.keys()
    assert calls == ["W1"]
