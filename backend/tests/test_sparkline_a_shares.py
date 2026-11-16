"""A-share display sessions preserve real source bars, identities and gaps."""

import pytest
from alerts import provider_cache, provider_chart, sparklines, storage
from alerts.akshare_native import native_metadata
from alerts.sparkline_api import SparklineItem
from alerts.storage import ProviderBar
from test_sparklines import provider_rows, read, stamp


@pytest.mark.parametrize("now", ["2026-11-13T12:00:00+08:00", "2026-11-14T12:00:00+08:00"])
@pytest.mark.parametrize("family,exchange", [("sina-a", "SSE"), ("tencent-a", "SZSE")])
def test_reference_is_prior_displayed_day_native_daily_close(database, monkeypatch, now, family, exchange):
    monkeypatch.setattr(storage, "now_ms", lambda: stamp(now))
    meta = {**native_metadata(family), "source": "akshare", "symbol": exchange + ":688256",
            "asset_type": "EQUITY", "timezone": "Asia/Shanghai", "calendar": "source_date", "basis": "last"}
    monkeypatch.setattr(provider_chart, "metadata", lambda *a, **kw: meta)
    previous = stamp("2026-11-12T00:00:00+00:00")
    with database.begin() as db:
        provider_rows(db, meta, "M1", [stamp("2026-11-13T09:29:00+08:00")], price="1300")
        key = provider_rows(db, meta, "D1", [previous], price="1280.50")
        daily = db.get(ProviderBar, (key, previous))
        # Native daily bars finish at the exchange's confirmation boundary,
        # not midnight and not the chart's UTC day boundary.
        daily.payload = {**daily.payload, "end": stamp("2026-11-12T15:10:00+08:00")}
        # A cached quote for today, or another adjustment, cannot supply the
        # reference of Friday's displayed curve on Saturday.
        db.add(ProviderBar(dataset_id=key, start=stamp("2026-11-13T00:00:00+00:00"),
            chart_time=stamp("2026-11-13T00:00:00+00:00"), complete=True, observed_at=stamp(now),
            payload={"end": stamp("2026-11-13T15:10:00+08:00"), "close": "9999"}))
        other = provider_rows(db, {**meta, "adjustment": "qfq"}, "D1", [previous], price="8888")
        adjusted = db.get(ProviderBar, (other, previous))
        adjusted.payload = {**adjusted.payload, "end": daily.payload["end"]}
    item = read("MWP:ASHARE")[0]
    assert item["session"]["date"] == "2026-11-13"
    assert item["previous_close_price"] == "1280.50"
    assert item["previous_close_at"] == stamp("2026-11-12T15:10:00+08:00")


@pytest.mark.parametrize("frame,end,complete,expected", [
    ("D1", "15:10:00", True, "100"), ("D1", "15:10:00", False, None),
    ("M1", "15:00:00", True, "100"), ("M1", "14:59:00", True, None),
])
def test_a_share_reference_needs_confirmed_close(frame, end, complete, expected):
    left = stamp("2026-11-13T00:00:00+00:00")
    right = stamp("2026-11-12T" + end + "+08:00")
    row = {"start": stamp("2026-11-12T00:00:00+00:00") if frame == "D1" else right - 60000,
           "end": right, "close": "100", "complete": complete}
    def bounds(at):
        return sparklines.window(at, "EQUITY")
    reference = sparklines.closing_reference([(frame, [row], None)], left, bounds,
        {"source": "akshare", "symbol": "SSE:688256"})
    assert reference["previous_close_price"] == expected


def test_prepare_missing_reference_requests_daily_before_displayed_day(database, monkeypatch):
    now = stamp("2026-11-14T12:00:00+08:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    meta = {**native_metadata("tencent-a"), "source": "akshare", "symbol": "SSE:688256",
            "asset_type": "EQUITY", "timezone": "Asia/Shanghai", "calendar": "source_date", "basis": "last"}
    monkeypatch.setattr(provider_chart, "metadata", lambda *a, **kw: meta)
    with database.begin() as db:
        provider_rows(db, meta, "M1", [stamp("2026-11-13T09:29:00+08:00")])
    monkeypatch.setattr(provider_cache, "read", lambda *a, **kw: None)
    calls = []
    def fetch(key, actual_meta, frame, before, count, deadline, **kwargs):
        calls.append((actual_meta, frame, before, count, kwargs))
    monkeypatch.setattr(provider_cache, "fetch_page", fetch)
    response = sparklines.prepare(SparklineItem(ticker="MWP:ASHARE"))
    assert response["preparation"] == "ready"
    assert calls == [(meta, "D1", stamp("2026-11-13T00:00:00+00:00"), 3, {"revalidate": True})]


@pytest.mark.parametrize("family,exchange", [("sina-a", "SSE"), ("tencent-a", "SZSE")])
def test_native_axis_uses_displayed_trading_date_and_close_timestamps(database, monkeypatch, family, exchange):
    now = stamp("2026-11-14T12:00:00+08:00")  # Weekend: Friday's actual bars.
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    meta = {**native_metadata(family), "source": "akshare", "symbol": exchange + ":688256",
            "asset_type": "EQUITY", "timezone": "Asia/Shanghai", "calendar": "source_date", "basis": "last"}
    monkeypatch.setattr(provider_chart, "metadata", lambda *a, **kw: meta)
    times = [stamp("2026-11-13T" + time + "+08:00") for time in ["09:29:00", "10:00:00", "11:29:00", "12:59:00", "14:59:00"]]
    with database.begin() as db:
        provider_rows(db, meta, "M1", times)
    item = read("MWP:ASHARE")[0]
    assert item["session"] == {"date": "2026-11-13", "previous": True}
    assert item["display_segments"] == [
        {"start": stamp("2026-11-13T09:30:00+08:00"), "end": stamp("2026-11-13T11:30:00+08:00")},
        {"start": stamp("2026-11-13T13:00:00+08:00"), "end": stamp("2026-11-13T15:00:00+08:00")},
    ]
    assert [point["time"] for point in item["points"]] == times
    assert [point["display_time"] for point in item["points"]] == [at + 60000 for at in times]
    assert item["points"][3]["gap_before"], "scheduled lunch remains an explicit data break"
    assert item["reference_times"] == []
    assert item["revision"] == {"cache_revision": 4}


def test_provisional_close_never_extends_beyond_observation_time():
    now = stamp("2026-11-13T10:00:20+08:00")
    rows = [{"start": now - 20000, "end": now + 40000, "close": "100", "complete": False}]
    output = (now - 3600000, now + 3600000, "M1", rows, None, {})
    output = sparklines.display_axis(output, {"source": "akshare", "provider_symbol": "SSE:688256"})
    item = sparklines.result("MWP:ASHARE", *output[:5], now, session=output[5])
    assert item["points"][0]["display_time"] == now


@pytest.mark.parametrize("symbol", ["SSE:688256", "SZSE:000001", "BSE:920001"])
def test_selfbuilt_identity_uses_same_display_clock(symbol):
    at = stamp("2026-11-13T10:00:00+08:00")
    output = (at, at + 86400000, "M1", [{"start": at}], None, {})
    assert len(sparklines.display_axis(output, {"source": "akshare", "provider_symbol": symbol})[5]["display_segments"]) == 2


@pytest.mark.parametrize("identity", [{"source": "yahoo", "symbol": "NVDA"},
    {"source": "akshare", "symbol": "HKEX:00700"}, {"source": "akshare", "symbol": "SHFE:AU0"},
    {"source": "binance", "symbol": "BTCUSDT"}])
def test_other_markets_keep_existing_axis(identity):
    output = (0, 86400000, "M1", [{"start": 0}], None, {})
    assert sparklines.display_axis(output, identity)[5] == {}
