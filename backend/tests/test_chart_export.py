import csv
import io

import pytest
from alerts.chart_export import chart_csv


def test_export_preserves_prices_time_warmup_and_missing_volume():
    bars = [
        dict(
            start=t,
            end=t + 60000,
            open="1.1234567890",
            high="2",
            low="-0.1",
            close="1",
            complete=False,
            revision=2,
        )
        for t in (0, 60000)
    ]
    page = dict(
        bars=bars,
        basis="bid",
        calendar="ny17",
        indicators=[
            dict(
                name="EMA",
                series=[
                    dict(
                        key="value", values=[dict(time=0, value=None), dict(time=60000, value=1.25)]
                    )
                ],
            )
        ],
    )
    result = chart_csv(page, instrument='=HYPERLINK("bad")', timeframe="M1")
    rows = list(csv.DictReader(io.StringIO(result.decode("utf-8-sig"))))
    assert rows[0]["open"] == "1.1234567890"
    assert rows[0]["low"] == "-0.1"
    assert rows[0]["start_utc"] == "1970-01-01T00:00:00.000+00:00"
    assert rows[0]["instrument"].startswith("'=")
    assert rows[0]["complete"] == "false"
    assert rows[0]["volume"] == rows[0]["python:1:EMA:value"] == ""
    assert rows[1]["python:1:EMA:value"] == "1.25"
    page["bars"] = bars + bars
    with pytest.raises(ValueError, match="chronological"):
        chart_csv(page, instrument="EURUSD", timeframe="M1")


def test_export_api_waits_for_coverage_and_preserves_auth(database, monkeypatch):
    from alerts import api as api_module
    from alerts import market_data
    from alerts.storage import Bar
    from fastapi.testclient import TestClient

    with TestClient(api_module.app) as client:
        assert client.post("/api/charts/export", json={}).status_code == 401
    with database.begin() as db:
        db.add(
            Bar(
                instrument_id="BTCUSDT",
                timeframe="M1",
                start=60000,
                end=120000,
                open=1,
                high=2,
                low=1,
                close=2,
                complete=True,
            )
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            request = dict(instrument="BTCUSDT", timeframe="M1", start=60000, end=120000)
            monkeypatch.setattr(market_data, "queue_history", lambda *args: ([], []))
            pending = client.post("/api/charts/export", json=request)
            assert pending.status_code == 202
            assert pending.json()["status"] == "pending"
            assert "text/csv" not in pending.headers["content-type"]
            monkeypatch.setattr(
                market_data,
                "queue_history",
                lambda db, inst, left, right: ([], [{"start": left, "end": right}]),
            )
            ready = client.post("/api/charts/export", json=request)
            assert ready.status_code == 200, ready.text
            rows = list(csv.DictReader(io.StringIO(ready.content.decode("utf-8-sig"))))
            assert len(rows) == 1 and rows[0]["start_ms"] == "60000"
            assert rows[0]["close"] == "2.0000000000"
            assert ready.headers["cache-control"] == "no-store"
            assert (
                client.post("/api/charts/export", json={**request, "end": 60000}).status_code == 422
            )
    finally:
        api_module.app.dependency_overrides.clear()


def test_export_exact_limit_after_empty_leading_interval(database, monkeypatch):
    from alerts import api as api_module
    from alerts import market_data
    from alerts.storage import Bar
    from fastapi.testclient import TestClient

    with database.begin() as db:
        db.add_all(
            [
                Bar(
                    instrument_id="BTCUSDT",
                    timeframe="M1",
                    start=i * 60000,
                    end=(i + 1) * 60000,
                    open=1,
                    high=2,
                    low=1,
                    close=2,
                    complete=True,
                )
                for i in range(1, 2002)
            ]
        )
    monkeypatch.setattr(
        market_data,
        "queue_history",
        lambda db, inst, left, right: ([], [{"start": left, "end": right}]),
    )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            body = dict(instrument="BTCUSDT", timeframe="M1", start=0, end=2001 * 60000)
            response = client.post("/api/charts/export", json=body)
            assert response.status_code == 200, response.text
            assert (
                len(list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))) == 2000
            )
            overflow = client.post("/api/charts/export", json={**body, "end": 2002 * 60000})
            assert overflow.status_code == 413
    finally:
        api_module.app.dependency_overrides.clear()


def test_export_bounds_cold_work_and_rejects_cached_overflow_before_queue(database, monkeypatch):
    from alerts import api as api_module
    from alerts import market_data
    from alerts.storage import Bar
    from fastapi.testclient import TestClient

    queued = []

    def queue(db, inst, left, right):
        queued.append((left, right))
        return [], []

    monkeypatch.setattr(market_data, "queue_history", queue)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            body = dict(instrument="BTCUSDT", timeframe="M1", start=0, end=365 * 86400000)
            response = client.post("/api/charts/export", json=body)
            assert response.status_code == 202
            assert len(queued) == 1
            assert queued[0][1] == body["end"]
            assert queued[0][1] - queued[0][0] <= 4000 * 60000
            queued.clear()
            with database.begin() as db:
                db.add_all(
                    [
                        Bar(
                            instrument_id="BTCUSDT",
                            timeframe="M1",
                            start=body["end"] - (i + 1) * 60000,
                            end=body["end"] - i * 60000,
                            open=1,
                            high=2,
                            low=1,
                            close=2,
                            complete=True,
                        )
                        for i in range(2001)
                    ]
                )
            response = client.post("/api/charts/export", json=body)
            assert response.status_code == 413
            assert queued == [], "known oversized exports must not enqueue any missing history"
    finally:
        api_module.app.dependency_overrides.clear()


def test_export_cold_windows_advance_without_treating_empty_time_as_bars(database, monkeypatch):
    from alerts import api as api_module
    from alerts import market_data
    from fastapi.testclient import TestClient

    coverage, queued = [], []
    monkeypatch.setattr(market_data, "stored_coverage", lambda *args: list(coverage))

    def queue(db, inst, left, right):
        queued.append((left, right))
        coverage.append({"start": left, "end": right})
        return [], [{"start": left, "end": right}]

    monkeypatch.setattr(market_data, "queue_history", queue)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            body = dict(instrument="BTCUSDT", timeframe="M1", start=0, end=9000 * 60000)
            responses = [client.post("/api/charts/export", json=body) for _ in range(3)]
            assert [r.status_code for r in responses] == [202, 202, 200]
            assert queued == [
                (5000 * 60000, 9000 * 60000),
                (1000 * 60000, 5000 * 60000),
                (0, 1000 * 60000),
            ]
            assert (
                list(csv.DictReader(io.StringIO(responses[-1].content.decode("utf-8-sig")))) == []
            )
            assert client.post("/api/charts/export", json=body).status_code == 200
            assert len(queued) == 3, "complete cached coverage must not schedule again"
    finally:
        api_module.app.dependency_overrides.clear()
