"""F1 additive migration and multi-owner contracts on a unique isolated schema."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alerts import briefing_service as service
from alerts import briefing_worker as worker
from alerts import storage
from alerts.storage import AdvancedPreference, BriefingReport, Notification
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from test_briefing import NOW, seed
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires task-owned PostgreSQL"
)


def test_real_old_head_upgrade_preserves_preferences_and_notifications(monkeypatch):
    url = os.environ["TEST_POSTGRES_URL"]
    schema = "briefing_migration_" + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as db:
        db.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = (
        make_url(url)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setattr(storage.settings, "database_url", isolated)
    config = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
    engine = create_engine(isolated, pool_size=1, max_overflow=0)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        command.upgrade(config, "bd57_notice_source_poll_index")
        with factory.begin() as db:
            db.add(
                Notification(
                    id="migration-fixture",
                    kind="system",
                    status="recorded",
                    created_at=NOW,
                    payload={"message": "keep"},
                )
            )
            db.add(
                AdvancedPreference(
                    id="migration-watch",
                    kind="setting",
                    name="mw.watchlists.v1",
                    tool="",
                    revision=4,
                    content={"value": {"lists": []}},
                )
            )
        command.upgrade(config, "head")
        with factory() as db:
            assert db.get(Notification, "migration-fixture").payload == {"message": "keep"}
            assert db.get(AdvancedPreference, "migration-watch").revision == 4
            assert (
                db.scalar(text("SELECT version_num FROM alembic_version"))
                == "be58_market_briefings"
            )
            assert db.scalar(text("SELECT count(*) FROM briefing_plans")) == 0, (
                "Never enable daily sends on upgrade"
            )
            assert db.scalar(text("SELECT count(*) FROM briefing_reports")) == 0
        command.upgrade(config, "head")
    finally:
        engine.dispose()
        with admin.begin() as db:
            db.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


def test_parallel_due_preview_and_attempt_fencing(provider_pg):
    factory, _ = provider_pg
    with factory.begin() as db:
        seed(db)

    def due(_):
        with factory.begin() as db:
            row = service.due(db, at=NOW)
            return row.id if row else None

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(due, range(8)))
    assert sum(value is not None for value in results) == 1
    request = str(uuid.uuid4())

    def preview(_):
        with factory.begin() as db:
            return service.preview(db, request, at=NOW)["id"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert set(pool.map(preview, range(6))) == {request}

    def claim(_):
        return worker.claim(at=NOW)

    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(claim, range(4)))
    assert len([task for task in claims if task]) == 2
    assert len({task["id"] for task in claims if task}) == 2
    for task in filter(None, claims):
        assert not worker.publish({**task, "attempt": 0}, "ready", {}, at=NOW)
        assert worker.publish(
            task, "ready", {"coverage": {"ok": 0, "total": 0}, "sections": []}, at=NOW
        )
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(BriefingReport)) == 2
