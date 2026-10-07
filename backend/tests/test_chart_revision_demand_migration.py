"""Upgrade the deployed lease shape without retargeting existing consumers."""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.storage import Instrument, MarketDemand
from sqlalchemy import create_engine, inspect, text
from test_market_usage import switched_targets


def verify_revision_demand_migration(factory, engine, monkeypatch):
    _, ticker, revision, _, _, _ = switched_targets(factory, monkeypatch)
    path = Path(__file__).resolve().parents[2] / "migrations/versions/am40_chart_revision_demand.py"
    spec = importlib.util.spec_from_file_location("chart_revision_demand_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        # Recreate the real previous deployed shape, without a revision column.
        MarketDemand.__table__.drop(conn)
        conn.execute(text("CREATE TABLE market_data_demand (id VARCHAR(40) PRIMARY KEY, "
            "instrument_id VARCHAR(40) NOT NULL REFERENCES instruments(id), "
            "expires BIGINT NOT NULL, updated_at BIGINT NOT NULL)"))
        for column in ("instrument_id", "expires"):
            conn.execute(text(f"CREATE INDEX ix_market_data_demand_{column} ON market_data_demand ({column})"))
        conn.execute(text("INSERT INTO market_data_demand VALUES ('legacy', :ticker, 320010000, 200010000)"),
                     {"ticker": ticker})
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        migration.upgrade()
        assert conn.execute(text("SELECT id, instrument_id, expires, updated_at, composite_revision_id "
                                 "FROM market_data_demand")).one() == ("legacy", ticker, 320010000, 200010000, None)
        assert {"instrument_id", "composite_revision_id"} == {
            fk["constrained_columns"][0] for fk in inspect(conn).get_foreign_keys("market_data_demand")}
        assert "ix_market_data_demand_composite_revision_id" in {i["name"] for i in inspect(conn).get_indexes("market_data_demand")}
        conn.execute(text("UPDATE market_data_demand SET composite_revision_id = :revision"), {"revision": revision})
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
        conn.execute(text("UPDATE market_data_demand SET composite_revision_id = NULL"))
        migration.downgrade()
        assert "composite_revision_id" not in {c["name"] for c in inspect(conn).get_columns("market_data_demand")}
        migration.upgrade()
    with factory() as db:
        assert db.get(Instrument, ticker)
        row = db.get(MarketDemand, "legacy")
        assert row.instrument_id == ticker and row.composite_revision_id is None


def test_sqlite_chart_revision_demand_migration(tmp_path, monkeypatch):
    from alerts import storage
    from sqlalchemy.orm import sessionmaker

    engine = create_engine("sqlite:///" + str(tmp_path / "lease.db"))
    storage.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    try:
        verify_revision_demand_migration(factory, engine, monkeypatch)
        with engine.connect() as conn:
            assert conn.execute(text("PRAGMA foreign_key_check")).all() == []
    finally:
        engine.dispose()
