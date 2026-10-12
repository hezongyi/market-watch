"""Failed writes roll back fully before lease/cursor/control are rechecked."""

import os

import pytest
from sqlalchemy import event, func, select

from alerts import history_versions as history
from alerts.storage import Bar, HistoryChunk, HistoryRun, HistoryVersion
from test_history_maintenance import Adapter
from test_market_contracts import identity
from test_market_datasets import register
from test_provider_postgres import provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize("sqlstate", ["40P01", "40001"])
@pytest.mark.parametrize("failures", [1, 3])
def test_import_retries_entire_commit_without_refetching(provider_pg, sqlstate, failures):
    factory, engine = provider_pg
    with factory.begin() as db:
        instrument = register(db)
        version_id = history.create_version(db, identity().key, 0, 120000)
        instrument_id = instrument.id
    adapter = Adapter()
    attempts = []

    def fail_after_price_write(connection, cursor, sql, params, context, many):
        if sql.startswith("INSERT INTO market_history_chunks"):
            attempts.append(sql)
            if len(attempts) <= failures:
                # The real PG session aborts after ingest wrote prices. Recovery
                # must release that transaction before reading state or retrying.
                connection.exec_driver_sql(
                    f"DO $$ BEGIN RAISE EXCEPTION 'acceptance conflict' USING ERRCODE='{sqlstate}'; END $$")

    event.listen(engine, "before_cursor_execute", fail_after_price_write)
    try:
        assert history.import_page(adapter, version_id=version_id)
    finally:
        event.remove(engine, "before_cursor_execute", fail_after_price_write)
    assert adapter.calls == [(0, 120000)], "A transaction retry must reuse its immutable supplier page"
    assert len(attempts) == min(3, failures + 1), "At most three fresh transactions"
    with factory.begin() as db:
        version = db.get(HistoryVersion, version_id)
        if failures < 3:
            assert version.status == "published" and version.cursor == 120000
            assert db.scalar(select(func.count()).select_from(HistoryChunk)) == 1
            assert db.scalar(select(func.count()).select_from(Bar).where(
                Bar.instrument_id == instrument_id)) == 2
        else:
            assert version.status == "retrying" and version.cursor == 0
            assert version.error == "database_conflict" and version.attempts == 1
            assert db.scalar(select(HistoryChunk)) is None
            assert db.scalar(select(Bar)) is None


@pytest.mark.parametrize("change", ["cancel", "pause", "lease", "cursor"])
def test_retry_rechecks_controls_after_rollback(provider_pg, change):
    factory, engine = provider_pg
    with factory.begin() as db:
        register(db)
        from alerts.history_maintenance import configure, create_run
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        version_id = create_run(db, identity().key, end=120000, request_id="control").id
    failed = []

    def conflict(connection, cursor, sql, params, context, many):
        if sql.startswith("INSERT INTO market_history_chunks") and not failed:
            failed.append(True)
            connection.exec_driver_sql(
                "DO $$ BEGIN RAISE EXCEPTION 'acceptance conflict' USING ERRCODE='40001'; END $$")

    def between_transactions(_seconds):
        with factory.begin() as db:
            version = db.get(HistoryVersion, version_id)
            if change in ("cancel", "pause"):
                db.get(HistoryRun, version_id).desired_state = "cancelled" if change == "cancel" else "paused"
            elif change == "lease":
                version.lease_token = "successor"
            else:
                version.cursor = 60000

    from unittest.mock import patch
    event.listen(engine, "before_cursor_execute", conflict)
    try:
        with patch("time.sleep", between_transactions):
            assert history.import_page(Adapter(), version_id=version_id)
    finally:
        event.remove(engine, "before_cursor_execute", conflict)
    with factory.begin() as db:
        version = db.get(HistoryVersion, version_id)
        assert db.scalar(select(HistoryChunk)) is None
        assert db.scalar(select(Bar)) is None
        assert version.cursor == (60000 if change == "cursor" else 0)
        if change in ("cancel", "pause"):
            assert version.status == ("cancelled" if change == "cancel" else "paused")
        elif change == "lease":
            assert version.lease_token == "successor"


def test_one_failed_worker_phase_does_not_exit_or_starve_other_phases(database, monkeypatch):
    from alerts import history_artifacts, history_maintenance, composite_preparation
    from alerts import composite_aggregates, composite_revisions, fixed_indicators
    from sqlalchemy.exc import OperationalError

    calls = []
    def failed(*args):
        calls.append("artifact-failed")
        raise OperationalError("acceptance", {}, RuntimeError("test"))
    monkeypatch.setattr(history_artifacts, "artifact_tick", failed)
    for module, method in [(history_maintenance, "schedule_tick"),
            (composite_preparation, "preparation_tick"), (composite_aggregates, "aggregate_tick"),
            (composite_revisions, "preparation_tick"), (fixed_indicators, "indicator_tick")]:
        monkeypatch.setattr(module, method, lambda *args, method=method: calls.append(method) or False)
    monkeypatch.setattr(history, "import_page", lambda *args, **kw: calls.append("import") or True)
    assert history.worker_tick(object())
    assert calls == ["artifact-failed", "schedule_tick", "preparation_tick", "aggregate_tick",
        "indicator_tick", "preparation_tick", "import"]
    from alerts.worker_health import services
    with database() as db:
        row = next(row for row in services(db) if row["id"] == "history_versions")
    assert row["status"] == "degraded"
    assert row["errors"] == ["artifacts:OperationalError"]
