from datetime import UTC, datetime
from decimal import Decimal

import pytest
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


def test_quote_subscription_renews_deduplicated_demand(database):
    from alerts.storage import MarketDemand, now_ms

    with database.begin() as db:
        db.get(Instrument, "EURUSD").source = "oanda"
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            for _ in range(2):
                response = client.post(
                    "/api/market-data/quotes",
                    json={"symbols": ["EURUSD", "EURUSD", "UNKNOWN"], "client": "quote-test"},
                )
                assert response.status_code == 200
            with database.begin() as db:
                leases = list(db.scalars(select(MarketDemand)))
                assert len(leases) == 1
                assert leases[0].instrument_id == "EURUSD"
                assert now_ms() < leases[0].expires <= now_ms() + 120000
    finally:
        api_module.app.dependency_overrides.clear()


def test_quote_change_uses_complete_adjacent_session(database):
    from alerts.storage import instant

    with database.begin() as db:
        write_bars(
            db,
            "BTCUSDT",
            "D1",
            [
                Candle(
                    instant(86400000),
                    instant(172800000),
                    Decimal("100"),
                    Decimal("100"),
                    Decimal("100"),
                    Decimal("100"),
                )
            ],
        )
        write_bars(
            db,
            "BTCUSDT",
            "M1",
            [
                Candle(
                    instant(172800000),
                    instant(172860000),
                    Decimal("110"),
                    Decimal("110"),
                    Decimal("110"),
                    Decimal("110"),
                )
            ],
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            values = client.post("/api/market-data/quotes", json={"symbols": ["BTCUSDT"]}).json()[
                0
            ]["v"]
            assert values["ch"] == 10 and values["chp"] == 10 and values["prev_close_price"] == 100
            with database.begin() as db:
                daily = db.scalar(select(Bar).where(Bar.timeframe == "D1"))
                daily.complete = False
            values = client.post("/api/market-data/quotes", json={"symbols": ["BTCUSDT"]}).json()[
                0
            ]["v"]
            assert "ch" not in values
    finally:
        api_module.app.dependency_overrides.clear()


def test_quote_previous_close_crosses_weekend_but_not_missing_weekday(database):
    from alerts.storage import instant

    friday = ms(datetime(2026, 9, 25, 21, tzinfo=UTC))
    sunday = ms(datetime(2026, 9, 27, 21, tzinfo=UTC))
    with database.begin() as db:
        write_bars(
            db,
            "EURUSD",
            "D1",
            [
                Candle(
                    instant(friday - 86400000),
                    instant(friday),
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("1"),
                )
            ],
        )
        write_bars(
            db,
            "EURUSD",
            "M1",
            [
                Candle(
                    instant(sunday),
                    instant(sunday + 60000),
                    Decimal("1.1"),
                    Decimal("1.1"),
                    Decimal("1.1"),
                    Decimal("1.1"),
                )
            ],
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            result = client.post("/api/market-data/quotes", json={"symbols": ["EURUSD"]}).json()[0][
                "v"
            ]
            assert result["chp"] == 10
            with database.begin() as db:
                tail = db.scalar(select(Bar).where(Bar.timeframe == "M1"))
                tail.start += 86400000
                tail.end += 86400000
            result = client.post("/api/market-data/quotes", json={"symbols": ["EURUSD"]}).json()[0][
                "v"
            ]
            assert "ch" not in result
    finally:
        api_module.app.dependency_overrides.clear()


def test_quote_previous_close_handles_ny_dst_and_gold_holiday(database):
    from alerts.storage import instant

    cases = [
        ("EURUSD", "2026-03-06T22:00:00+00:00", "2026-03-08T21:00:00+00:00", None),
        (
            "XAUUSD",
            "2026-12-24T22:00:00+00:00",
            "2026-12-27T23:00:00+00:00",
            {
                "revision": "quote-test",
                "closures": [
                    {
                        "start": "2026-12-24T22:00:00Z",
                        "end": "2026-12-25T22:00:00Z",
                        "reason": "test holiday",
                        "source": "https://example.com/calendar",
                        "kind": "holiday",
                    }
                ],
            },
        ),
    ]
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            for ident, previous_end, latest, profile in cases:
                end = ms(datetime.fromisoformat(previous_end))
                start = ms(datetime.fromisoformat(latest))
                with database.begin() as db:
                    if profile:
                        db.get(Instrument, ident).calendar_profile = profile
                    write_bars(
                        db,
                        ident,
                        "D1",
                        [
                            Candle(
                                instant(end - 86400000),
                                instant(end),
                                Decimal("100"),
                                Decimal("100"),
                                Decimal("100"),
                                Decimal("100"),
                            )
                        ],
                    )
                    write_bars(
                        db,
                        ident,
                        "M1",
                        [
                            Candle(
                                instant(start),
                                instant(start + 60000),
                                Decimal("105"),
                                Decimal("105"),
                                Decimal("105"),
                                Decimal("105"),
                            )
                        ],
                    )
                values = client.post("/api/market-data/quotes", json={"symbols": [ident]}).json()[
                    0
                ]["v"]
                assert values["chp"] == 5
                if profile:
                    with database.begin() as db:
                        db.get(Instrument, ident).calendar_profile = {}
                    values = client.post(
                        "/api/market-data/quotes", json={"symbols": [ident]}
                    ).json()[0]["v"]
                    assert "chp" not in values
    finally:
        api_module.app.dependency_overrides.clear()


def test_quote_quality_distinguishes_open_stale_from_weekend(database, monkeypatch):
    from alerts import market_data
    from alerts.storage import instant

    friday = ms(datetime(2026, 9, 25, 21, tzinfo=UTC))
    with database.begin() as db:
        write_bars(
            db,
            "EURUSD",
            "M1",
            [
                Candle(
                    instant(friday - 60000),
                    instant(friday),
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("1"),
                )
            ],
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            for offset, quality in [
                (60000, "fresh"),
                (86400000, "closed"),
                (3 * 86400000, "stale"),
            ]:
                monkeypatch.setattr(market_data, "now_ms", lambda: friday + offset)
                row = client.post("/api/market-data/quotes", json={"symbols": ["EURUSD"]}).json()[0]
                assert row["quality"] == quality
                assert row["age_ms"] == offset
                assert "2026-09-25 21:00 UTC" in row["v"]["description"]
    finally:
        api_module.app.dependency_overrides.clear()


@pytest.mark.parametrize("injected", [False, True])
def test_chart_pages_yield_to_waiting_history_requests(database, monkeypatch, injected):
    from alerts import market

    clock = [ms(datetime(2026, 9, 1, tzinfo=UTC))]
    monkeypatch.setattr(market, "now_ms", lambda: clock[0])
    starts = [ms(datetime(2026, 8, 1, tzinfo=UTC)), ms(datetime(2026, 7, 1, tzinfo=UTC))]
    with database.begin() as db:
        db.get(Instrument, "EURUSD").source = "oanda"
        for start in starts:
            db.add(
                ImportJob(
                    instrument_id="EURUSD",
                    start=start,
                    end=start + 10 * 86400000,
                    cursor=start,
                    priority=100,
                    next_at=clock[0],
                    created_at=start,
                )
            )
    fetched = []

    def fetch(source, symbol, left, right):
        start = ms(datetime.fromisoformat(left))
        end = ms(datetime.fromisoformat(right))
        fetched.append(start)
        return {"rows": [], "coverage": [{"start": start, "end": end}]}

    monkeypatch.setattr(market, "fetch_source", fetch)
    # Coverage is the upstream query result; ingestion is orthogonal to scheduling.
    monkeypatch.setattr(market, "ingest", lambda *args: None)
    assert market.import_once(chart_only=True, fetcher=fetch if injected else None)
    clock[0] += 2000
    assert market.import_once(chart_only=True, fetcher=fetch if injected else None)
    assert set(fetched) == set(starts), "both requests must get a page before either gets two"
    with database.begin() as db:
        jobs = db.scalars(select(ImportJob)).all()
        assert all(j.cursor == j.start + 4000 * 60000 for j in jobs)
        assert all(j.status == "pending" for j in jobs)


def test_covered_range_does_not_wait_for_job_remaining_outside_it(database):
    from alerts.storage import MarketCoverage

    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        db.add(
            MarketCoverage(
                instrument_id=inst.id, source=inst.source, basis=inst.basis, start=60000, end=600000
            )
        )
        db.add(
            ImportJob(
                instrument_id=inst.id,
                start=60000,
                end=1200000,
                cursor=600000,
                status="pending",
                priority=100,
            )
        )
        db.flush()
        jobs, coverage = queue_history(db, inst, 60000, 600000)
        assert jobs == []
        from alerts.coverage import covers_interval

        assert covers_interval(coverage, 60000, 600000)


def test_background_history_is_promoted_by_foreground_demand(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        jobs, _ = queue_history(db, inst, 60000, 600000, priority=200)
        ident = jobs[0].id
        assert jobs[0].priority == 200
        shared, _ = queue_history(db, inst, 60000, 600000)
        assert len(shared) == 1 and shared[0].id == ident
        assert shared[0].priority == 100
        shared, _ = queue_history(db, inst, 60000, 600000, priority=200)
        assert shared[0].priority == 100
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 1


@pytest.mark.parametrize("timeframe", ["W1"])
def test_high_period_missing_history_uses_background_queue(database, timeframe):
    with database.begin() as db:
        db.get(Instrument, "EURUSD").source = "oanda"
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post(
                "/api/market-data/history",
                json={
                    "instrument": "EURUSD",
                    "timeframe": timeframe,
                    "before": 1700000000000,
                    "limit": 90,
                },
            )
            assert response.status_code == 200
            result = response.json()
            assert result["status"] == "pending"
            assert result["queue_class"] == "background"
            assert result["estimated_seconds"] is None
            with database() as db:
                jobs = db.scalars(select(ImportJob)).all()
                assert jobs and all(job.priority == 200 for job in jobs)
    finally:
        api_module.app.dependency_overrides.clear()


def test_monthly_history_never_queues_downloads(database, monkeypatch):
    from alerts import market_data

    def forbidden(*args, **kwargs):
        raise AssertionError("monthly view must not schedule backfill")

    monkeypatch.setattr(market_data, "queue_history", forbidden)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            body = dict(instrument="BTCUSDT", timeframe="MN", before=1700000000000, limit=2000)
            empty = client.post("/api/market-data/history", json=body)
            assert empty.status_code == 200
            assert empty.json()["local_only"] is True
            assert empty.json()["bars"] == []
            with database.begin() as db:
                db.add(
                    Bar(
                        instrument_id="BTCUSDT",
                        timeframe="D1",
                        start=1698796800000,
                        end=1698883200000,
                        open=1,
                        high=2,
                        low=1,
                        close=2,
                        complete=True,
                    )
                )
            ready = client.post("/api/market-data/history", json=body)
            assert ready.status_code == 200
            assert ready.json()["status"] == "ready"
            assert len(ready.json()["bars"]) == 1
            assert ready.json()["queue_class"] == "cache_only"
            assert ready.json()["task_ids"] == []
            with database() as db:
                assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
    finally:
        api_module.app.dependency_overrides.clear()


def test_chart_timeout_preserves_failure_type_and_cursor(database, caplog):
    import httpx
    from alerts import market

    with database.begin() as db:
        job = ImportJob(instrument_id="EURUSD", start=60000, end=120000,
                        cursor=60000, priority=100, next_at=0)
        db.add(job)
        db.flush()
        ident = job.id

    def fail(*args):
        raise httpx.ReadTimeout("")

    assert market.import_once(chart_only=True, fetcher=fail)
    assert "error_type=ReadTimeout" in caplog.text
    assert "attempt=1" in caplog.text
    with database.begin() as db:
        job = db.get(ImportJob, ident)
        assert job.error == "ReadTimeout"
        assert job.status == "pending"
        assert job.cursor == 60000
        assert job.attempts == 1


@pytest.mark.parametrize("retry_after,expected", [
    ("600", 1_600_000), ("", 1_300_000),
    ("Thu, 01 Jan 1970 00:30:00 GMT", 1_800_000),
])
def test_chart_rate_limit_defers_other_jobs_for_same_source(database, monkeypatch, retry_after, expected):
    import httpx
    from alerts import market
    from alerts.storage import Preference

    monkeypatch.setattr(market, "now_ms", lambda: 1_000_000)
    with database.begin() as db:
        for ident in ("EURUSD", "XAUUSD"):
            db.get(Instrument, ident).source = "oanda"
            db.add(ImportJob(instrument_id=ident, start=60000, end=120000,
                             cursor=60000, priority=100, next_at=0))
    calls = []

    def limited(*args):
        calls.append(args[1])
        response = httpx.Response(429, headers={"Retry-After": retry_after},
                                 request=httpx.Request("GET", "https://example.test/candles"))
        response.raise_for_status()

    assert market.import_once(chart_only=True, fetcher=limited)
    assert not market.import_once(chart_only=True, fetcher=limited)
    assert len(calls) == 1
    with database.begin() as db:
        assert db.get(Preference, "market_backoff:oanda").value["until"] == expected
        assert all(j.cursor == 60000 for j in db.scalars(select(ImportJob)))
