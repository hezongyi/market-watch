"""Actual stock sessions survive pre-open/weekends without coloring old data live."""
import pytest
from alerts import provider_cache, provider_chart, sparklines, storage
from alerts.sparkline_api import SparklineItem
from test_sparklines import provider_rows, read, stamp

META = {"source": "yahoo", "symbol": "NVDA", "asset_type": "EQUITY",
        "timezone": "America/New_York", "session": "0930-1600:23456",
        "frames": ["M1", "M5"], "calendar": "yahoo", "precision": 2, "basis": "trade", "adjustment": "auto"}


def stock(monkeypatch, now):
    monkeypatch.setattr(storage, "now_ms", lambda: stamp(now))
    monkeypatch.setattr(provider_chart, "metadata", lambda *a, **kw: META)


@pytest.mark.parametrize("now", ["2026-11-07T12:00:00+00:00", "2026-11-09T14:35:00+00:00"])
def test_previous_actual_session_until_current_data_exists(database, monkeypatch, now):
    stock(monkeypatch, now)
    friday = stamp("2026-11-06T14:30:00+00:00")
    with database.begin() as db:
        provider_rows(db, META, "M1", [friday, friday + 60000, friday + 389 * 60000])
    item = read("MWP:NVDA")[0]
    assert len(item["points"]) == 3
    assert item["session"]["date"] == "2026-11-06" and item["session"]["previous"]
    assert item["window_start"] == friday
    assert item["window_end"] == stamp("2026-11-06T21:00:00+00:00")
    assert item["valid_until"] > stamp(now), "display axis and snapshot expiration are different"
    assert item["reference_times"] == [], "stocks must not inherit FX London/NY reference lines"


def test_current_coarse_bars_replace_old_fine_bars_and_use_exchange_date(database, monkeypatch):
    stock(monkeypatch, "2026-11-10T00:15:00+00:00")  # Still Monday in New York.
    monday = stamp("2026-11-09T14:30:00+00:00")
    with database.begin() as db:
        provider_rows(db, META, "M1", [stamp("2026-11-06T14:30:00+00:00")])
        provider_rows(db, META, "M5", [monday], price="125")
    item = read("MWP:NVDA")[0]
    assert item["timeframe"] == "M5" and item["points"][0]["price"] == "125"
    assert item["session"] == {"date": "2026-11-09", "previous": False}
    assert item["window_start"] == monday
    assert item["valid_until"] == stamp("2026-11-10T05:00:00+00:00")


@pytest.mark.parametrize("now,opening", [("2026-03-09T16:00:00+00:00", "2026-03-09T13:30:00+00:00"),
                                         ("2026-11-09T16:00:00+00:00", "2026-11-09T14:30:00+00:00")])
def test_regular_session_axis_obeys_exchange_dst(database, monkeypatch, now, opening):
    stock(monkeypatch, now)
    with database.begin() as db:
        provider_rows(db, META, "M1", [stamp(opening)])
    item = read("MWP:NVDA")[0]
    assert item["window_start"] == stamp(opening)
    assert item["window_end"] - item["window_start"] == 390 * 60000
    assert not item["session"]["previous"]


def test_fallback_uses_latest_date_across_frames_and_rejects_ancient_cache(database, monkeypatch):
    stock(monkeypatch, "2026-11-09T13:00:00+00:00")
    with database.begin() as db:
        provider_rows(db, META, "M1", [stamp("2026-11-05T14:30:00+00:00")])
        provider_rows(db, META, "M5", [stamp("2026-11-06T14:30:00+00:00")])
    assert read("MWP:NVDA")[0]["session"]["date"] == "2026-11-06"
    stock(monkeypatch, "2026-12-09T13:00:00+00:00")
    assert read("MWP:NVDA")[0]["points"] == []


def test_cold_stock_preparation_requests_previous_actual_bars(database, monkeypatch):
    stock(monkeypatch, "2026-11-09T05:01:00+00:00")
    calls = []
    monkeypatch.setattr(provider_cache, "read", lambda meta, frame, before, count, **kw:
                        calls.append((frame, before, count)))
    response = sparklines.prepare(SparklineItem(ticker="MWP:NVDA"))
    assert response["preparation"] == "ready"
    assert calls[0][2] >= 390, "a cold pre-open watch needs actual prior bars, not minutes since midnight"
    assert calls[0][2] <= 1600


def test_cold_history_reader_crosses_weekend_and_reuses_cache(database, monkeypatch):
    stock(monkeypatch, "2026-11-09T13:00:00+00:00")
    now = storage.now_ms()
    monkeypatch.setattr(provider_cache, "now_ms", lambda: now)
    opening = stamp("2026-11-06T14:30:00+00:00")
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((before, count))
        return {"bars": [{"start": at, "chart_time": at, "end": at + 60000,
            "open": "100", "high": "100", "low": "100", "close": "100", "complete": True}
            for at in range(opening, opening + 390 * 60000, 60000) if at < before],
            "history_boundary": True}

    monkeypatch.setattr(provider_chart, "native_page", fetch)
    assert read("MWP:NVDA")[0]["points"] == []
    response = sparklines.prepare(SparklineItem(ticker="MWP:NVDA"))
    assert response["preparation"] == "ready"
    assert len(response["items"][0]["points"]) == 390
    assert response["items"][0]["session"] == {"date": "2026-11-06", "previous": True}
    assert calls
    calls.clear()
    sparklines.prepare(SparklineItem(ticker="MWP:NVDA"))
    assert calls == [], "same pre-open request reuses history coverage"
