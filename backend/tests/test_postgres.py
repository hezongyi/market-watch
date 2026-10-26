"""Explicit opt-in isolated PostgreSQL acceptance. Never accepts the application URL."""

import os
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D

import pytest
from alerts import notify, storage
from alerts.chart_alert_service import consume, create
from alerts.storage import Bar, ChartAlert, Outbox, SignalRow
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from test_chart_alert_service import config, sample

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
            ident = create(db, "race", config(notify_ntfy=True), at=0).id
            consume(db, ident, sample(0, 9), detected_at=0)

        def trigger(_):
            with factory.begin() as db:
                return bool(consume(db, ident, sample(1, 11), detected_at=300001))

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(trigger, range(4)))
        assert results.count(True) == 1
        with factory.begin() as db:
            assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
            assert db.scalar(select(func.count()).select_from(Outbox)) == 1
            assert db.get(ChartAlert, ident).count == 1
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


def test_postgres_weekly_demand_dedup_and_concurrent_claim(monkeypatch):
    import uuid
    from threading import Event

    from alerts import market_data
    from alerts.storage import WeeklyHistoryRequest

    engine = create_engine(URL, pool_size=2, max_overflow=0)
    schema = "acceptance_" + uuid.uuid4().hex
    with engine.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(URL, pool_size=2, max_overflow=0,
                             connect_args={"options": f"-csearch_path={schema}"})
    try:
        storage.bootstrap(isolated)
        factory = sessionmaker(isolated, expire_on_commit=False)
        monkeypatch.setattr(storage, "Session", factory)
        end = 1700000000000
        query = market_data.HistoryQuery(instrument="EURUSD", timeframe="W1", before=end, limit=2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: market_data.remember_weekly_request(query, end), range(2)))
        with factory() as db:
            assert db.scalar(select(func.count()).select_from(WeeklyHistoryRequest)) == 1
        entered, release = Event(), Event()
        def plan(body):
            entered.set()
            assert release.wait(10)
            return {"status":"ready", "requested_start":body.before-200,
                    "next_cursor":body.before-200, "bars":[{"start":body.before-100}]}
        monkeypatch.setattr(market_data, "plan_history", plan)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(market_data.advance_weekly_request)
            try:
                assert entered.wait(10)
                # First worker released its DB connection while planning, but
                # its persisted lease prevents a second claim of the same page.
                assert pool.submit(market_data.advance_weekly_request).result(timeout=10) is False
            finally:
                release.set()
            assert first.result(timeout=10)
        with factory.begin() as db:
            row = db.scalar(select(WeeklyHistoryRequest))
            assert row.cursor == end-100 and row.remaining == 1
            row.next_at = 0
        # New Session reads the persisted cursor, as a restarted worker would.
        assert market_data.advance_weekly_request()
        with factory() as db:
            row = db.scalar(select(WeeklyHistoryRequest))
            assert row.status == "complete" and row.remaining == 0
    finally:
        isolated.dispose()
        with engine.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()


def test_postgres_weekly_migration_roundtrip():
    """Exercise actual Alembic scripts, without bootstrap creating the new table."""
    import subprocess
    import sys
    import uuid
    from pathlib import Path

    from sqlalchemy import inspect
    from sqlalchemy.engine import make_url

    engine = create_engine(URL, pool_size=1, max_overflow=0)
    schema = "acceptance_" + uuid.uuid4().hex
    root = Path(__file__).resolve().parents[2]
    with engine.begin() as connection:
        connection.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(URL, pool_size=1, max_overflow=0,
        connect_args={"options":f"-csearch_path={schema}"})
    try:
        env = os.environ.copy()
        env["ALERTS_DATABASE_URL"] = make_url(URL).update_query_dict(
            {"options":f"-csearch_path={schema}"}).render_as_string(hide_password=False)
        env["PYTHONPATH"] = str(root / "backend")
        # Exercise the historical reversible range; aw50 deliberately retains notice data.
        for action, target in [("upgrade","av49_indicator_demands"),("downgrade","h9_chart_preferences"),("upgrade","av49_indicator_demands")]:
            result = subprocess.run([sys.executable, '-m', 'alembic', action, target],
                cwd=root,env=env,capture_output=True,text=True,timeout=60)
            # Do not print the captured output: connection failures may include credentials.
            assert result.returncode == 0, f"Alembic {action} failed (output withheld)"
            inspector = inspect(isolated)
            assert inspector.has_table("weekly_history_requests") == (action == "upgrade")
            if action == "upgrade":
                columns = {column["name"]:column for column in inspector.get_columns("weekly_history_requests")}
                expected = storage.WeeklyHistoryRequest.__table__
                assert set(columns) == set(expected.columns.keys())
                for column in expected.columns:
                    assert columns[column.name]["nullable"] == column.nullable
                assert {i["name"] for i in inspector.get_indexes("weekly_history_requests")} == {
                    index.name for index in expected.indexes}
    finally:
        isolated.dispose()
        with engine.begin() as connection:
            connection.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()
