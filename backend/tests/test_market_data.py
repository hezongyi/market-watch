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


def test_empty_covered_window_probes_earlier_but_is_bounded(database):
    from alerts.market_data import DAY
    from alerts.storage import MarketCoverage

    # A Monday request whose initial lookback contains only a closed weekend.
    right = ms(datetime(2026, 1, 12, 0, tzinfo=UTC))
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        db.add(
            MarketCoverage(
                instrument_id=inst.id,
                source=inst.source,
                basis=inst.basis,
                start=right - 3 * DAY,
                end=right,
            )
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            payload = {"instrument": "EURUSD", "timeframe": "M1", "before": right, "limit": 300}
            result = client.post("/api/market-data/history", json=payload).json()
            assert result["status"] == "pending"
            assert result["requested_start"] < right - 3 * DAY
            with database.begin() as db:
                for job in db.scalars(select(ImportJob)):
                    db.delete(job)
                db.add(
                    MarketCoverage(
                        instrument_id="EURUSD",
                        source="oanda",
                        basis=inst.basis,
                        start=right - 40 * DAY,
                        end=right,
                    )
                )
                from alerts.storage import instant

                earlier = right - 4 * DAY
                write_bars(
                    db,
                    "EURUSD",
                    "M1",
                    [
                        Candle(
                            instant(earlier),
                            instant(earlier + 60000),
                            Decimal("1.2"),
                            Decimal("1.2"),
                            Decimal("1.2"),
                            Decimal("1.2"),
                        )
                    ],
                )
            loaded = client.post("/api/market-data/history", json=payload).json()
            assert loaded["status"] == "ready"
            assert loaded["bars"][0]["start"] == earlier
            with database.begin() as db:
                for bar in db.scalars(select(Bar)):
                    db.delete(bar)
            result = client.post("/api/market-data/history", json=payload).json()
            assert result["status"] == "empty_interval"
            assert result["remote_boundary"] == "unknown"
            assert result["task_ids"] == []
            assert result["requested_start"] >= right - 10 * DAY
    finally:
        api_module.app.dependency_overrides.clear()


def test_partial_countback_requests_more_history(database):
    from alerts.market_data import DAY
    from alerts.storage import MarketCoverage, instant

    right = ms(datetime(2026, 1, 12, tzinfo=UTC))
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        db.add(
            MarketCoverage(
                instrument_id=inst.id,
                source=inst.source,
                basis=inst.basis,
                start=right - 3 * DAY,
                end=right,
            )
        )
        write_bars(
            db,
            inst.id,
            "M1",
            [
                Candle(
                    instant(right - 60000),
                    instant(right),
                    Decimal("1.2"),
                    Decimal("1.2"),
                    Decimal("1.2"),
                    Decimal("1.2"),
                )
            ],
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            result = client.post(
                "/api/market-data/history",
                json={"instrument": "EURUSD", "timeframe": "M1", "before": right, "limit": 300},
            ).json()
            assert len(result["bars"]) == 1
            assert result["status"] == "pending"
            assert result["task_ids"]
            assert result["requested_start"] < right - 3 * DAY
    finally:
        api_module.app.dependency_overrides.clear()


def test_failed_history_exposes_retryable_jobs(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        job = ImportJob(
            instrument_id=inst.id,
            start=1699000000000,
            end=1700000000000,
            cursor=1699000000000,
            priority=100,
            status="failed",
            error="network failure",
            attempts=5,
        )
        db.add(job)
        db.flush()
        ident = job.id
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
            ).json()
            assert result["status"] == "error"
            assert result["failed_task_ids"] == [ident]
            assert client.post("/api/market-data/retry/" + ident).status_code == 200
            with database.begin() as db:
                job = db.get(ImportJob, ident)
                assert job.status == "pending" and job.attempts == 0 and job.error is None
    finally:
        api_module.app.dependency_overrides.clear()


def test_quotes_preserve_basis_and_do_not_invent_missing_prices(database):
    from alerts.storage import instant

    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.basis = "bid"
        write_bars(
            db,
            inst.id,
            "M1",
            [
                Candle(
                    instant(60000),
                    instant(120000),
                    Decimal("1.2"),
                    Decimal("1.2"),
                    Decimal("1.2"),
                    Decimal("1.2"),
                )
            ],
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            result = client.post(
                "/api/market-data/quotes", json={"symbols": ["EURUSD", "EURUSD", "UNKNOWN"]}
            ).json()
            assert len(result) == 2
            assert result[0]["v"]["lp"] == result[0]["v"]["bid"] == 1.2
            assert "ask" not in result[0]["v"] and "ch" not in result[0]["v"]
            assert result[0]["as_of"] == 120000
            assert result[1]["s"] == "error" and "lp" not in result[1]["v"]
    finally:
        api_module.app.dependency_overrides.clear()
