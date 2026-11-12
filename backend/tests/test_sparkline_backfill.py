"""Watchlist history preparation regression, with a real cache and source double."""
import time

from alerts import provider_cache, provider_chart, sparklines, storage
from alerts.sparkline_api import SparklineItem
from test_provider_cache import seed
from test_sparklines import catalog, provider_rows, read, stamp


def test_new_watch_symbol_includes_earlier_today(database, monkeypatch):
    now = stamp("2026-11-11T12:00:00+00:00")
    left = stamp("2026-11-11T00:00:00+00:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    monkeypatch.setattr(provider_cache, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db)
    meta = provider_chart.metadata("TEST", cached_only=True)
    seed(meta, "M1", now, {"bars": [{"start": now - 60000, "end": now,
        "chart_time": now - 60000, "open": "2", "high": "2", "low": "2",
        "close": "2", "complete": True}], "history_boundary": False})
    calls = []
    def fetch(meta, frame, before, count, **kwargs):
        assert kwargs["deadline"] - time.monotonic() > 19, "history needs budget beyond the live quote request"
        calls.append((frame, before, count))
        return {"bars": [{"start": at, "chart_time": at, "end": at + 60000,
            "open": "2", "high": "2", "low": "2", "close": "2", "complete": True}
            for at in range(before - count * 60000, before, 60000)],
            "history_boundary": False}
    monkeypatch.setattr(provider_chart, "native_page", fetch)
    assert read("MWP:TEST")[0]["points"][0]["time"] == now - 60000
    response = sparklines.prepare(SparklineItem(ticker="MWP:TEST"))
    assert response["preparation"] == "ready"
    assert calls and sum(call[2] for call in calls) <= 1600
    item = read("MWP:TEST")[0]
    assert item["points"][0]["time"] <= left + 60000, "new favorite only contains subscription tail, missing earlier today"

    calls.clear()
    sparklines.prepare(SparklineItem(ticker="MWP:TEST"))
    assert calls == [], "repeat preparation reuses the shared history cache"


def test_prepare_failure_keeps_tail_and_non_provider_never_fetches(database, monkeypatch):
    now = stamp("2026-11-11T12:00:00+00:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    monkeypatch.setattr(provider_cache, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db)
    meta = provider_chart.metadata("TEST", cached_only=True)
    with database.begin() as db:
        provider_rows(db, meta, "M1", [now - 60000])
    calls = []
    def fail(*args, **kwargs):
        calls.append(True)
        raise TimeoutError("supplier unavailable")
    monkeypatch.setattr(provider_chart, "native_page", fail)
    result = sparklines.prepare(SparklineItem(ticker="MWP:TEST"))
    assert result["preparation"] == "retry"
    assert result["items"][0]["points"][0]["time"] == now - 60000
    calls.clear()
    assert sparklines.prepare(SparklineItem(ticker="TEST"))["preparation"] == "unsupported"
    assert not calls


def test_history_preparation_requires_session_and_csrf(database):
    from alerts import api
    from alerts.storage import LoginSession
    from fastapi.testclient import TestClient

    with database.begin() as db:
        db.add(LoginSession(token_hash=api.digest("spark-history"), csrf="csrf", expires=storage.now_ms() + 100000))
    with TestClient(api.app) as client:
        path, body = "/api/market-data/sparklines/prepare", {"ticker": "UNREGISTERED"}
        assert client.post(path, json=body).status_code == 401
        client.cookies.set("session", "spark-history")
        assert client.post(path, json=body).status_code == 403
        response = client.post(path, json=body, headers={"x-csrf-token": "csrf"})
        assert response.status_code == 200 and response.json()["preparation"] == "unsupported"
        assert client.post(path, json={**body, "start": 0}, headers={"x-csrf-token": "csrf"}).status_code == 422
