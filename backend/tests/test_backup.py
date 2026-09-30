import json
import os
import stat
import uuid
from decimal import Decimal

import pytest
from alerts import api as api_module
from alerts import backup, storage
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def test_sqlite_backup_checks_contents_permissions_and_refuses_overwrite(tmp_path, monkeypatch):
    source = tmp_path / "source.db"
    engine = create_engine("sqlite:///" + str(source))
    storage.bootstrap(engine)
    engine.dispose()
    monkeypatch.setattr(backup.settings, "database_url", "sqlite:///" + str(source))
    target = tmp_path / "backup.db"
    report = backup.backup(target)
    assert report["counts"]["instruments"] == 4
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(target.with_name("backup.db.json").stat().st_mode) == 0o600
    assert backup.restore_check(target)["verified"]
    original = target.read_bytes()
    with pytest.raises(FileExistsError):
        backup.backup(target)
    assert target.read_bytes() == original
    # A valid SQLite file with modified bytes must fail archive verification.
    target.write_bytes(original + b"changed")
    with pytest.raises(ValueError, match="hash"):
        backup.restore_check(target)


def test_failed_backup_removes_partial_artifact(tmp_path, monkeypatch):
    source = tmp_path / "source.db"
    source.write_bytes(b"not a database")
    monkeypatch.setattr(backup.settings, "database_url", "sqlite:///" + str(source))
    target = tmp_path / "backup.db"
    with pytest.raises(Exception):
        backup.backup(target)
    assert not target.exists() and not target.with_name("backup.db.json").exists()


def test_backup_health_does_not_expose_file_path(database):
    assert api_module.health()["backup"]["status"] == "unknown"
    with database.begin() as db:
        db.add(
            storage.Audit(
                kind="backup_completed",
                at=storage.now_ms() - 40 * 3600000,
                details={"file": "/private/backup.db", "bytes": 42},
            )
        )
    assert api_module.health()["backup"]["status"] == "stale"
    with database.begin() as db:
        db.add(storage.Audit(kind="backup_failed", details={"error_type": "OSError"}))
    assert api_module.health()["backup"]["status"] == "failed"
    with database.begin() as db:
        db.add(
            storage.Audit(
                kind="backup_completed", details={"file": "/private/backup.db", "bytes": 42}
            )
        )
    result = api_module.health()["backup"]
    assert result["status"] == "recent" and "/private" not in json.dumps(result)


def test_postgres_credentials_are_passed_in_environment_only(monkeypatch):
    monkeypatch.setenv("PGSERVICE", "unrelated-service")
    from sqlalchemy.engine import make_url

    env = backup.pg_env(
        make_url("postgresql+psycopg://alice:secret@localhost:25432/test?sslmode=require")
    )
    assert env["PGPASSWORD"] == "secret" and env["PGDATABASE"] == "test"
    assert env["PGSSLMODE"] == "require" and "PGSERVICE" not in env


@pytest.mark.skipif(
    not (os.getenv("TEST_POSTGRES_URL") and os.getenv("TEST_POSTGRES_BIN_DIR")),
    reason="Requires an isolated PostgreSQL server and matching dump/restore tools",
)
def test_postgres_dump_restore_of_signal_and_outbox(tmp_path, monkeypatch):
    from alerts.service import create_watch, evaluate_watch

    url = make_url(os.environ["TEST_POSTGRES_URL"])
    name = "backup_source_" + uuid.uuid4().hex
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    created = False
    try:
        with admin.connect() as c:
            c.execute(text(f'CREATE DATABASE "{name}" TEMPLATE template0'))
            created = True
        source_url = url.set(database=name)
        engine = create_engine(source_url)
        try:
            storage.bootstrap(engine)
            factory = sessionmaker(engine, expire_on_commit=False)
            with factory.begin() as db:
                for i, prices in enumerate([(10, 11, 8, 9), (9, 10, 7, 8), (8, 12, 7, 11)]):
                    db.add(
                        storage.Bar(
                            instrument_id="EURUSD",
                            timeframe="H4",
                            start=i * 14400000,
                            end=(i + 1) * 14400000,
                            open=Decimal(prices[0]),
                            high=Decimal(prices[1]),
                            low=Decimal(prices[2]),
                            close=Decimal(prices[3]),
                            complete=True,
                        )
                    )
                db.flush()
                watch = create_watch(
                    db, "EURUSD", "restore-check", {"kind": "pullback"}, armed_at=28800000
                )
                assert evaluate_watch(db, watch.id)
                db.add(
                    storage.AdvancedWorkspace(
                        id="restore-workspace",
                        name="恢复演练",
                        document={
                            "engine": "tv31",
                            "state": {"charts": [{"panes": []}], "layout": "4"},
                        },
                        revision=7,
                    )
                )
                for kind in ("study", "drawing", "chart", "setting"):
                    db.add(
                        storage.AdvancedPreference(
                            id="restore-" + kind,
                            kind=kind,
                            name="恢复-" + kind,
                            tool="LineToolHorzLine" if kind == "drawing" else "",
                            content={"value": {"marker": kind, "unicode": "参数"}},
                            revision=3,
                        )
                    )
                db.add(
                    storage.WeeklyHistoryRequest(
                        id="restore-weekly",
                        instrument_id="EURUSD",
                        before=100000,
                        cursor=90000,
                        remaining=13,
                        status="pending",
                        next_at=80000,
                    )
                )
            # Validate contents through the actual restored connection before
            # restore_check drops its disposable database; counts alone miss
            # damaged JSON or lost queue progress.
            original_counts = backup.sql_counts
            restored_payloads_checked = []

            def check_contents(connection):
                if connection.engine.url.database.startswith("alerts_restore_"):
                    workspace = (
                        connection.execute(
                            select(storage.AdvancedWorkspace.__table__).where(
                                storage.AdvancedWorkspace.id == "restore-workspace"
                            )
                        )
                        .mappings()
                        .one()
                    )
                    assert workspace["revision"] == 7
                    assert workspace["document"]["state"]["layout"] == "4"
                    for kind in ("study", "drawing", "chart", "setting"):
                        pref = (
                            connection.execute(
                                select(storage.AdvancedPreference.__table__).where(
                                    storage.AdvancedPreference.id == "restore-" + kind
                                )
                            )
                            .mappings()
                            .one()
                        )
                        assert pref["revision"] == 3
                        assert pref["content"] == {"value": {"marker": kind, "unicode": "参数"}}
                        assert pref["tool"] == ("LineToolHorzLine" if kind == "drawing" else "")
                    weekly = (
                        connection.execute(
                            select(storage.WeeklyHistoryRequest.__table__).where(
                                storage.WeeklyHistoryRequest.id == "restore-weekly"
                            )
                        )
                        .mappings()
                        .one()
                    )
                    assert (
                        weekly["cursor"],
                        weekly["remaining"],
                        weekly["status"],
                        weekly["next_at"],
                    ) == (90000, 13, "pending", 80000)
                    restored_payloads_checked.append(True)
                return original_counts(connection)

            monkeypatch.setattr(backup, "sql_counts", check_contents)

            monkeypatch.setattr(
                backup.settings, "database_url", source_url.render_as_string(hide_password=False)
            )
            monkeypatch.setattr(
                backup.settings, "postgres_bin_dir", os.environ["TEST_POSTGRES_BIN_DIR"]
            )
            destination = tmp_path / "postgres.dump"
            report = backup.backup(destination)
            assert report["counts"]["signals"] == report["counts"]["outbox"] == 1
            assert report["counts"]["advanced_chart_workspaces"] == 1
            assert report["counts"]["advanced_chart_preferences"] == 4
            assert report["counts"]["weekly_history_requests"] == 1
            restored = backup.restore_check(destination)
            assert restored_payloads_checked == [True]
            assert restored["verified"] and restored["counts"] == report["counts"]
            with admin.connect() as c:
                assert not c.execute(
                    text("SELECT datname FROM pg_database WHERE datname LIKE 'alerts_restore_%'")
                ).all()
        finally:
            engine.dispose()
    finally:
        if created:
            with admin.connect() as c:
                c.execute(text(f'DROP DATABASE "{name}"'))
        admin.dispose()
