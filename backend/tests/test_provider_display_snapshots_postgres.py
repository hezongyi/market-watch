"""Snapshot capacity, independent locks and fast hits on isolated PostgreSQL."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import provider_display_snapshots as snapshots
from alerts.storage import Preference
from sqlalchemy import BigInteger, cast, event, func, select, text
from test_provider_postgres import provider_pg as _provider_pg

STAMP = 1794537000000

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


def publish(ident):
    snapshots.publish({"provider_snapshot_id": ident, "_provider_snapshot": {"test": ident}})


def test_concurrent_publications_renewals_and_expiry_never_exceed_capacity(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(snapshots, "MAX_SNAPSHOTS", 8)
    monkeypatch.setattr(snapshots, "now_ms", lambda: STAMP)
    with factory.begin() as db:
        db.add(Preference(key="unrelated", value={"expires": 1}))
        for number in range(8):
            db.add(Preference(key=snapshots.PREFIX + f"old-{number}", value={"expires": STAMP - 1, "content": {}}))
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(publish, [f"new-{number}" for number in range(32)]))
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(Preference).where(
            Preference.key.startswith(snapshots.PREFIX))) == 8
        assert db.scalar(select(func.count()).select_from(Preference).where(
            Preference.key.startswith(snapshots.PREFIX), cast(Preference.value["expires"].as_string(), BigInteger) <= STAMP)) == 0
        assert db.get(Preference, "unrelated")
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(publish, ["same"] * 24))
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(Preference).where(
            Preference.key.startswith(snapshots.PREFIX))) == 8
        assert db.get(Preference, snapshots.PREFIX + "same").value["expires"] == STAMP + snapshots.LEASE_MS


def test_snapshot_does_not_wait_on_observation_lock_and_fresh_hit_does_not_lock(provider_pg, monkeypatch):
    factory, engine = provider_pg
    monkeypatch.setattr(snapshots, "now_ms", lambda: STAMP)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with factory.begin() as db:
            db.execute(text("SELECT pg_advisory_xact_lock(8675311)"))
            pool.submit(publish, "fresh").result(timeout=3)
        with factory.begin() as db:
            db.execute(text("SELECT pg_advisory_xact_lock(8675320)"))
            pool.submit(publish, "fresh").result(timeout=3)
    statements = []
    def observed(_conn, _cursor, statement, *_args):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", observed)
    try:
        publish("fresh")
        assert len(statements) == 1
        assert "pg_advisory" not in statements[0]
        assert "INSERT" not in statements[0] and "DELETE" not in statements[0]
    finally:
        event.remove(engine, "before_cursor_execute", observed)
