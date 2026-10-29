import json
import os
import stat
import sys
import uuid
from pathlib import Path

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
    assert stat.S_IMODE(target.with_name("backup.db.complete").stat().st_mode) == 0o600
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
    assert not target.with_name("backup.db.complete").exists()


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
    from alerts.chart_alert_service import consume, create
    from test_chart_alert_service import config, sample

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
                rule = create(db, "restore-check", config(notify_ntfy=True), at=0)
                consume(db, rule.id, sample(0, 9), detected_at=0)
                assert consume(db, rule.id, sample(1, 11), detected_at=300001)
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
                db.add(storage.ChartAggregationJob(id="restore-aggregation",
                    instrument_id="EURUSD", timeframe="D1", start=60000, end=120000,
                    attempts=3, next_at=180000, error="ValueError"))
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
                    aggregation = connection.execute(select(
                        storage.ChartAggregationJob.__table__).where(
                        storage.ChartAggregationJob.id == "restore-aggregation")).mappings().one()
                    assert (aggregation["instrument_id"], aggregation["timeframe"],
                            aggregation["start"], aggregation["end"], aggregation["attempts"],
                            aggregation["next_at"], aggregation["error"]) == (
                                "EURUSD", "D1", 60000, 120000, 3, 180000, "ValueError")
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


class FakeConnection:
    """Stands in for the metadata connection; pg tools still run as real subprocesses."""

    def execution_options(self, **_):
        return self

    def begin(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def scalar(self, _):
        return "0000-1"

    def execute(self, _):
        return None


class FakeEngine:
    def __init__(self):
        self.connection = FakeConnection()
        self.disposed = False

    def connect(self):
        return self.connection

    def dispose(self):
        self.disposed = True


class FakePgBackend:
    """PostgreSQL backup with a stubbed metadata layer and real pg_dump/pg_restore scripts."""

    def __init__(self, tmp_path, monkeypatch):
        self.bin_dir = tmp_path / "bin"
        self.bin_dir.mkdir()
        self.args_log = tmp_path / "args.log"
        self.directory = tmp_path / "backups"
        self.directory.mkdir()
        self.counts = {"instruments": 4}
        self.engines = []
        self.audit = create_engine("sqlite:///" + str(tmp_path / "audit.db"))
        storage.Audit.__table__.create(self.audit)
        monkeypatch.setattr(storage, "Session", sessionmaker(self.audit, expire_on_commit=False))
        monkeypatch.setattr(
            backup.settings, "database_url", "postgresql+psycopg://alice:secret@db.invalid/test"
        )
        monkeypatch.setattr(backup.settings, "postgres_bin_dir", str(self.bin_dir))
        monkeypatch.setattr(backup.settings, "backup_timeout_seconds", 5)
        monkeypatch.setattr(backup, "create_engine", self.engine)
        monkeypatch.setattr(backup, "sql_counts", lambda connection: dict(self.counts))
        # pg_env() strips PG* variables, so the fake tools read a neutral name.
        monkeypatch.setenv("ARGS_LOG", str(self.args_log))

    def engine(self, *args, **kwargs):
        engine = FakeEngine()
        self.engines.append(engine)
        return engine

    def tool(self, name, body):
        path = self.bin_dir / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def logged_args(self):
        return self.args_log.read_text().split()

    def outputs(self):
        return sorted(path.name for path in self.directory.iterdir())

    def audit_details(self, kind):
        with self.audit.connect() as connection:
            row = connection.execute(
                select(storage.Audit.details)
                .where(storage.Audit.kind == kind)
                .order_by(storage.Audit.id.desc())
                .limit(1)
            ).scalar()
        return row


DUMP_TO_FILE = """prev=
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$ARGS_LOG"
  if [ "$prev" = "--file" ]; then printf 'PGDMP' > "$arg"; fi
  prev=$arg
done
exit 0
"""


@pytest.fixture
def postgres_backend(tmp_path, monkeypatch):
    return FakePgBackend(tmp_path, monkeypatch)


def test_pg_dump_timeout_raises_stage_only_error(tmp_path, postgres_backend, monkeypatch):
    postgres_backend.tool("pg_dump", "exec sleep 5\n")
    monkeypatch.setattr(backup.settings, "backup_timeout_seconds", 1)
    target = tmp_path / "backup.dump"
    with pytest.raises(backup.BackupStepTimeout) as error:
        backup.backup(target)
    message = str(error.value)
    assert message == "pg_dump timed out after 1s" and error.value.stage == "pg_dump"
    # Connection string, host and filesystem paths must stay out of the message.
    for leaked in ("secret", "db.invalid", "alice", str(target)):
        assert leaked not in message
    assert not target.exists() and not target.with_name("backup.dump.json").exists()
    assert postgres_backend.engines[0].disposed


def test_pg_dump_timeout_is_audited_with_stage(postgres_backend, monkeypatch, capsys):
    postgres_backend.tool("pg_dump", "exec sleep 5\n")
    monkeypatch.setattr(backup.settings, "backup_timeout_seconds", 1)
    monkeypatch.setattr(
        sys, "argv", ["backup", "--directory", str(postgres_backend.directory)]
    )
    with pytest.raises(SystemExit) as exit_info:
        backup.main()
    assert exit_info.value.code == 1
    assert json.loads(capsys.readouterr().out.strip()) == {
        "completed": False,
        "error_type": "BackupStepTimeout",
        "stage": "pg_dump",
    }
    assert postgres_backend.outputs() == []
    assert postgres_backend.audit_details("backup_failed") == {
        "error_type": "BackupStepTimeout",
        "stage": "pg_dump",
    }


def test_pg_dump_nonzero_exit_fails_and_removes_partial_dump(tmp_path, postgres_backend):
    postgres_backend.tool("pg_dump", "printf 'PGDMP partial' > /dev/null\nexit 7\n")
    target = tmp_path / "backup.dump"
    with pytest.raises(RuntimeError, match="pg_dump failed with exit status 7") as error:
        backup.backup(target)
    assert error.value.stage == "pg_dump"
    assert not target.exists() and not target.with_name("backup.dump.json").exists()


def test_postgres_backup_records_stage_timings_and_audit(postgres_backend, monkeypatch):
    postgres_backend.tool("pg_dump", DUMP_TO_FILE)
    postgres_backend.tool("pg_restore", 'printf "%s\\n" "$@" >> "$ARGS_LOG"\nexit 0\n')
    monkeypatch.setattr(backup.settings, "backup_compress_level", 4)
    monkeypatch.setattr(
        sys, "argv", ["backup", "--directory", str(postgres_backend.directory)]
    )
    backup.main()
    (dump,) = list(postgres_backend.directory.glob("*.dump"))
    assert dump.with_name(dump.name + ".complete").is_file()
    record = json.loads(dump.with_name(dump.name + ".json").read_text())
    assert record["format"] == 1 and record["backend"] == "postgresql"
    assert record["bytes"] == dump.stat().st_size == 5
    assert record["sha256"] == backup.sha256(dump)
    assert record["compress"] == 4
    for stage in ("counts_ms", "dump_ms", "list_ms", "sha256_ms"):
        assert isinstance(record[stage], int) and record[stage] >= 0
    args = postgres_backend.logged_args()
    assert "--compress=4" in args and "--lock-wait-timeout=30s" in args
    assert "--snapshot" in args and "--list" in args
    details = postgres_backend.audit_details("backup_completed")
    assert details["file"] == str(dump.resolve())
    assert details["dump_ms"] == record["dump_ms"] and details["compress"] == 4
    assert set(("counts_ms", "list_ms", "sha256_ms")) <= set(details)


def test_manifest_write_failure_is_attributed_to_manifest_stage(
    postgres_backend, monkeypatch, capsys
):
    postgres_backend.tool("pg_dump", DUMP_TO_FILE)
    postgres_backend.tool("pg_restore", "exit 0\n")
    write_text = Path.write_text

    def fail_on_manifest(self, *args, **kwargs):
        if self.name.endswith(".json"):
            raise OSError(28, "No space left on device")
        return write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", fail_on_manifest)
    monkeypatch.setattr(
        sys, "argv", ["backup", "--directory", str(postgres_backend.directory)]
    )
    with pytest.raises(SystemExit) as exit_info:
        backup.main()
    assert exit_info.value.code == 1
    expected = {"completed": False, "error_type": "OSError", "stage": "manifest"}
    assert json.loads(capsys.readouterr().out.strip()) == expected
    # The finished dump is removed with the unwritable manifest.
    assert postgres_backend.outputs() == []
    assert postgres_backend.audit_details("backup_failed") == {
        "error_type": "OSError",
        "stage": "manifest",
    }


def test_restore_check_timeout_uses_configured_timeout(tmp_path, postgres_backend, monkeypatch):
    postgres_backend.tool("pg_restore", "exec sleep 5\n")
    monkeypatch.setattr(backup.settings, "backup_timeout_seconds", 1)
    dump = tmp_path / "backup.dump"
    dump.write_bytes(b"PGDMP")
    dump.with_name("backup.dump.json").write_text(
        json.dumps(
            {
                "format": 1,
                "backend": "postgresql",
                "created_at": 0,
                "sha256": backup.sha256(dump),
                "bytes": 5,
                "counts": {"instruments": 4},
            }
        )
    )
    with pytest.raises(backup.BackupStepTimeout) as error:
        backup.restore_check(dump)
    assert error.value.stage == "pg_restore"
    assert str(error.value) == "pg_restore timed out after 1s"


def test_restore_check_nonzero_exit_reports_stage_and_cleans_database(
    tmp_path, postgres_backend, monkeypatch, capsys
):
    postgres_backend.tool("pg_restore", "printf 'private diagnostic' >&2\nexit 7\n")
    dump = tmp_path / "restore.dump"
    dump.write_bytes(b"PGDMP")
    dump.with_name(dump.name + ".json").write_text(
        json.dumps(
            {"format": 1, "backend": "postgresql", "sha256": backup.sha256(dump),
             "counts": {"instruments": 4}}
        )
    )
    statements = []
    monkeypatch.setattr(FakeConnection, "execute", lambda self, query: statements.append(str(query)))
    monkeypatch.setattr(sys, "argv", ["backup", "--restore-check", str(dump)])
    with pytest.raises(SystemExit) as exit_info:
        backup.main()
    assert exit_info.value.code == 1
    assert json.loads(capsys.readouterr().out) == {
        "verified": False, "error_type": "RuntimeError", "stage": "pg_restore"
    }
    assert len(statements) == 2
    assert statements[0].startswith('CREATE DATABASE "alerts_restore_')
    assert statements[1].startswith('DROP DATABASE "alerts_restore_')
    assert postgres_backend.engines[0].disposed


def test_completion_marker_failure_removes_unfinished_backup(
    postgres_backend, monkeypatch, capsys
):
    postgres_backend.tool("pg_dump", DUMP_TO_FILE)
    postgres_backend.tool("pg_restore", "exit 0\n")
    private_file = backup.private_file

    def fail_on_marker(path):
        if path.name.endswith(".complete"):
            raise OSError(28, "No space left on device")
        return private_file(path)

    monkeypatch.setattr(backup, "private_file", fail_on_marker)
    monkeypatch.setattr(sys, "argv", ["backup", "--directory", str(postgres_backend.directory)])
    with pytest.raises(SystemExit):
        backup.main()
    assert json.loads(capsys.readouterr().out)["stage"] == "manifest"
    assert postgres_backend.outputs() == []
