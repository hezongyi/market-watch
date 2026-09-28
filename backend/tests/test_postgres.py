"""Explicit opt-in isolated PostgreSQL acceptance. Never accepts the application URL."""

import os
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D

import pytest
from alerts import notify, storage
from alerts.service import create_watch, evaluate_watch
from alerts.storage import Bar, Outbox, SignalRow, Watch
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

URL = os.getenv("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(
    not URL, reason="Set TEST_POSTGRES_URL to an isolated test database"
)


def test_postgres_concurrent_trigger_and_outbox_lease(monkeypatch):
    engine = create_engine(URL)
    # A dedicated schema ensures this test cannot remove unrelated application tables.
    import uuid

    schema = "acceptance_" + uuid.uuid4().hex
    with engine.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(URL, connect_args={"options": f"-csearch_path={schema}"})
    try:
        storage.bootstrap(isolated)
        factory = sessionmaker(isolated, expire_on_commit=False)
        monkeypatch.setattr(storage, "Session", factory)
        with factory.begin() as db:
            for i, p in enumerate([(10, 11, 8, 9), (9, 10, 7, 8), (8, 12, 7, 11)]):
                db.add(
                    Bar(
                        instrument_id="EURUSD",
                        timeframe="H4",
                        start=i * 14400000,
                        end=(i + 1) * 14400000,
                        open=D(p[0]),
                        high=D(p[1]),
                        low=D(p[2]),
                        close=D(p[3]),
                        complete=True,
                    )
                )
            db.flush()
            ident = create_watch(db, "EURUSD", "race", {"kind": "pullback"}, armed_at=28800000).id

        def trigger(_):
            with factory.begin() as db:
                return bool(evaluate_watch(db, ident))

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(trigger, range(4)))
        assert results.count(True) == 1
        with factory.begin() as db:
            assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
            assert db.scalar(select(func.count()).select_from(Outbox)) == 1
            assert db.get(Watch, ident).status == "triggered"
        from alerts import api as api_module

        run = api_module.new_replay(
            api_module.ReplayInput(
                instrument_id="EURUSD",
                timeframe="H4",
                start=28800000,
                end=43200000,
            )
        )
        assert run["warmup_bar_count"] == 2
        api_module.replay_watch(
            run["id"],
            api_module.WatchInput(
                instrument_id="EURUSD",
                name="compressed PG history",
                kind="pullback",
                timeframe="H4",
            ),
        )
        simulated = api_module.step(run["id"], api_module.StepInput(count=1))
        assert len(simulated["signals"]) == 1
        monkeypatch.setattr(notify.settings, "delivery_enabled", True)
        monkeypatch.setattr(notify.settings, "ntfy_topic", "test-only-no-send")
        with ThreadPoolExecutor(max_workers=4) as pool:
            claims = list(pool.map(lambda _: notify.claim(), range(4)))
        assert sum(c is not None for c in claims) == 1
    finally:
        isolated.dispose()
        with engine.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()


def test_postgres_oanda_coverage_query_and_sparse_aggregation():
    import uuid

    from alerts.market import ingest
    from alerts.storage import Audit, Instrument

    engine = create_engine(URL)
    schema = "coverage_" + uuid.uuid4().hex
    with engine.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(URL, connect_args={"options": f"-csearch_path={schema}"})
    try:
        storage.bootstrap(isolated)
        factory = sessionmaker(isolated)
        with factory.begin() as db:
            inst = db.get(Instrument, "EURUSD")
            inst.source = "oanda"
            payload = {
                "source": "oanda",
                "basis": "bid",
                "rows": [{"timestamp": 0, "open": 10, "high": 12, "low": 9, "close": 11}],
                "coverage": [{"start": 0, "end": 240000}],
            }
            ingest(db, inst, payload, received_at=305000)
            m5 = db.scalar(select(Bar).where(Bar.timeframe == "M5"))
            assert not m5.complete
            # Another instrument's coverage must not complete this instrument.
            db.add(
                Audit(
                    kind="provider_query_coverage",
                    details={
                        "instrument": "XAUUSD",
                        "basis": "bid",
                        "received_at": 305000,
                        "range_start": 240000,
                        "range_end": 300000,
                        "ranges": [{"start": 240000, "end": 300000}],
                    },
                )
            )
            ingest(db, inst, payload, received_at=305000)
            assert not m5.complete
            payload["rows"] = []
            payload["coverage"] = [{"start": 240000, "end": 300000}]
            ingest(db, inst, payload, received_at=305000)
            assert m5.complete and m5.close == D(11)
    finally:
        isolated.dispose()
        with engine.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()


def test_coverage_millisecond_json_uses_bigint():
    from alerts.market import stored_coverage
    from alerts.storage import Audit, Instrument

    engine = create_engine(URL)
    import uuid

    schema = "coverage_" + uuid.uuid4().hex
    with engine.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(URL, connect_args={"options": f"-csearch_path={schema}"})
    try:
        storage.Base.metadata.create_all(isolated)
        factory = sessionmaker(isolated)
        with factory.begin() as db:
            inst = Instrument(
                id="EURUSD",
                label="Euro",
                source="oanda",
                symbol="EUR_USD",
                basis="bid",
                calendar="ny17",
                precision=5,
            )
            db.add(inst)
            db.add(
                Audit(
                    kind="provider_query_coverage",
                    details={
                        "instrument": "EURUSD",
                        "basis": "bid",
                        "range_start": 1790623380000,
                        "range_end": 1790630520000,
                        "received_at": 1790630580000,
                        "ranges": [{"start": 1790623380000, "end": 1790630520000}],
                    },
                )
            )
            assert stored_coverage(db, inst, 1790623400000, 1790630500000) == [
                {"start": 1790623380000, "end": 1790630520000}
            ]
    finally:
        isolated.dispose()
        with engine.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()
