from datetime import UTC, datetime
from decimal import Decimal

from alerts import api as api_module
from alerts.bar_batch import write_bars
from alerts.domain import Candle
from alerts.market_data import missing_intervals, queue_history
from alerts.storage import Bar, ImportJob, Instrument, ms
from fastapi.testclient import TestClient
from sqlalchemy import func, select


def test_missing_intervals_are_half_open():
    assert list(
        missing_intervals([{"start": 20, "end": 40}, {"start": 30, "end": 60}], 0, 100)
    ) == [(0, 20), (60, 100)]


def test_history_jobs_share_work(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        jobs, _ = queue_history(db, inst, 60000, 600000)
        assert len(jobs) == 1
        again, _ = queue_history(db, inst, 120000, 720000)
        assert len(again) == 2
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 2
        assert sorted((j.start, j.end) for j in again) == [(60000, 600000), (600000, 720000)]


def test_no_local_data_is_not_exhaustion(database):
    with database.begin() as db:
        db.get(Instrument, "EURUSD").source = "oanda"
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            result = client.post(
                "/api/market-data/history",
                json={
                    "instrument": "EURUSD",
                    "timeframe": "M1",
                    "before": 1700000000000,
                    "limit": 300,
                },
            )
            assert result.status_code == 200
            body = result.json()
            assert body["status"] == "pending"
            assert body["remote_boundary"] == "unknown"
            assert body["task_ids"] and body["bars"] == []
    finally:
        api_module.app.dependency_overrides.clear()


def test_batch_idempotent_and_revision(database):
    left = datetime(2026, 1, 5, tzinfo=UTC)
    from datetime import timedelta

    def candle(price):
        return Candle(
            left,
            left + timedelta(minutes=1),
            Decimal(price),
            Decimal(price),
            Decimal(price),
            Decimal(price),
        )

    with database.begin() as db:
        write_bars(db, "EURUSD", "M1", [candle("1.2")])
        write_bars(db, "EURUSD", "M1", [candle("1.2")])
        row = db.scalar(select(Bar).where(Bar.instrument_id == "EURUSD", Bar.start == ms(left)))
        assert row.revision == 1
        write_bars(db, "EURUSD", "M1", [candle("1.3")])
        assert row.revision == 2 and row.close == Decimal("1.3")
        assert db.scalar(select(func.count()).select_from(Bar)) == 1


def test_worker_completion_between_cache_and_coverage_is_visible(database, monkeypatch):
    from datetime import timedelta

    from alerts import market_data
    from alerts.storage import instant

    with database.begin() as db:
        db.get(Instrument, "EURUSD").source = "oanda"

    def completes(db, inst, left, right):
        start = instant(right - 60000)
        write_bars(
            db,
            inst.id,
            "M1",
            [
                Candle(
                    start,
                    start + timedelta(minutes=1),
                    Decimal("1.2"),
                    Decimal("1.2"),
                    Decimal("1.2"),
                    Decimal("1.2"),
                )
            ],
        )
        return [], [{"start": left, "end": right}]

    monkeypatch.setattr(market_data, "queue_history", completes)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            result = client.post(
                "/api/market-data/history",
                json={
                    "instrument": "EURUSD",
                    "timeframe": "M1",
                    "before": 1700000000000,
                    "limit": 1,
                },
            ).json()
            assert result["status"] == "ready" and len(result["bars"]) == 1
    finally:
        api_module.app.dependency_overrides.clear()
