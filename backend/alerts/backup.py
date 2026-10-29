"""Private backups and restore verification, without delivery or market workers."""

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url

from .config import settings
from .storage import Audit, Base, now_ms, transaction


def private_file(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pg_env(url, *, database=None):
    # Password stays in the child's environment, never argv, manifest or diagnostics.
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    fields = {
        "PGHOST": url.host,
        "PGPORT": str(url.port or 5432),
        "PGUSER": url.username,
        "PGPASSWORD": url.password,
        "PGDATABASE": database or url.database,
    }
    options = {
        "sslmode": "PGSSLMODE",
        "sslrootcert": "PGSSLROOTCERT",
        "sslcert": "PGSSLCERT",
        "sslkey": "PGSSLKEY",
        "connect_timeout": "PGCONNECT_TIMEOUT",
        "options": "PGOPTIONS",
    }
    for key, value in url.query.items():
        if key not in options or not isinstance(value, str):
            raise ValueError("Unsupported PostgreSQL connection option for backup")
        fields[options[key]] = value
    env.update({key: value for key, value in fields.items() if value is not None})
    return env


class BackupStepTimeout(RuntimeError):
    """A pg tool hit backup_timeout_seconds. The message carries the stage only."""

    def __init__(self, stage, seconds):
        self.stage = stage
        self.seconds = seconds
        super().__init__(f"{stage} timed out after {seconds}s")


def pg_tool(name, args, env, *, stage):
    executable = str(Path(settings.postgres_bin_dir) / name)
    timeout = settings.backup_timeout_seconds
    try:
        result = subprocess.run([executable, *args], env=env, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        # TimeoutExpired carries the argv (paths included); report the stage only.
        raise BackupStepTimeout(stage, timeout) from None
    if result.returncode:
        # Server diagnostics can contain connection details. Keep them out of the UI/log.
        error = RuntimeError(f"{name} failed with exit status {result.returncode}")
        error.stage = stage
        raise error


def sql_counts(connection):
    return {
        name: connection.scalar(select(text("count(*)")).select_from(table))
        for name, table in sorted(Base.metadata.tables.items())
    }


def sqlite_counts(path):
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("SQLite foreign key check failed")
        return {
            name: db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            for name in sorted(Base.metadata.tables)
        }


def backup(destination: Path):
    url = make_url(settings.database_url)
    backend = url.get_backend_name()
    if backend not in {"sqlite", "postgresql"}:
        raise ValueError("Unsupported backup database")
    destination = destination.resolve()
    manifest = destination.with_name(destination.name + ".json")
    completion = destination.with_name(destination.name + ".complete")
    if completion.exists():
        raise FileExistsError("Backup completion marker already exists")
    if manifest.exists():
        raise FileExistsError("Backup manifest already exists")
    if backend == "sqlite" and (
        not url.database
        or url.database == ":memory:"
        or not Path(url.database).is_file()
        or Path(url.database).resolve() == destination
    ):
        raise ValueError("Backup requires a distinct file-backed SQLite source")
    private_file(destination)
    owns_manifest = False
    owns_completion = False
    stage = "prepare"
    try:
        if backend == "sqlite":
            stage = "sqlite_copy"
            started = time.monotonic()
            with (
                sqlite3.connect(
                    Path(url.database).resolve().as_uri() + "?mode=ro", uri=True
                ) as source,
                sqlite3.connect(destination) as target,
            ):
                source.backup(target)
            dump_ms = round((time.monotonic() - started) * 1000)
            stage = "counts"
            started = time.monotonic()
            counts = sqlite_counts(destination)
            counts_ms = round((time.monotonic() - started) * 1000)
            list_ms = 0
        else:
            engine = create_engine(settings.database_url)
            try:
                with (
                    engine.connect().execution_options(
                        isolation_level="REPEATABLE READ"
                    ) as connection,
                    connection.begin(),
                ):
                    snapshot = connection.scalar(text("SELECT pg_export_snapshot()"))
                    stage = "counts"
                    started = time.monotonic()
                    counts = sql_counts(connection)
                    counts_ms = round((time.monotonic() - started) * 1000)
                    stage = "pg_dump"
                    started = time.monotonic()
                    pg_tool(
                        "pg_dump",
                        [
                            "--format=custom",
                            "--no-owner",
                            f"--compress={settings.backup_compress_level}",
                            "--lock-wait-timeout=30s",
                            "--snapshot",
                            snapshot,
                            "--file",
                            str(destination),
                        ],
                        pg_env(url),
                        stage="pg_dump",
                    )
                    dump_ms = round((time.monotonic() - started) * 1000)
                stage = "pg_restore_list"
                started = time.monotonic()
                pg_tool(
                    "pg_restore",
                    ["--list", str(destination)],
                    pg_env(url),
                    stage="pg_restore_list",
                )
                list_ms = round((time.monotonic() - started) * 1000)
            finally:
                engine.dispose()
        stage = "sha256"
        started = time.monotonic()
        digest = sha256(destination)
        sha256_ms = round((time.monotonic() - started) * 1000)
        record = {
            "format": 1,
            "backend": backend,
            "created_at": now_ms(),
            "sha256": digest,
            "bytes": destination.stat().st_size,
            "counts": counts,
            "compress": settings.backup_compress_level,
            "counts_ms": counts_ms,
            "dump_ms": dump_ms,
            "list_ms": list_ms,
            "sha256_ms": sha256_ms,
        }
        stage = "manifest"
        private_file(manifest)
        owns_manifest = True
        manifest.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        private_file(completion)
        owns_completion = True
        return record
    except Exception as error:
        if owns_completion:
            completion.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        if owns_manifest:
            manifest.unlink(missing_ok=True)
        # Attribute the failure to a stage so the audit says where it stopped.
        error.stage = stage
        raise


def restore_check(path: Path):
    """Never restores over a named application DB. PG always creates a random new DB."""
    path = path.resolve()
    record = json.loads(path.with_name(path.name + ".json").read_text())
    if record.get("format") != 1 or sha256(path) != record["sha256"]:
        raise ValueError("Backup manifest/hash verification failed")
    if record["backend"] == "sqlite":
        actual = sqlite_counts(path)
    elif record["backend"] == "postgresql":
        url = make_url(settings.database_url)
        if url.get_backend_name() != "postgresql":
            raise ValueError("PostgreSQL verification needs a PostgreSQL admin connection")
        name = "alerts_restore_" + uuid.uuid4().hex
        admin = create_engine(settings.database_url, isolation_level="AUTOCOMMIT")
        created = False
        try:
            with admin.connect() as c:
                c.execute(text(f'CREATE DATABASE "{name}" TEMPLATE template0'))
                created = True
            pg_tool(
                "pg_restore",
                ["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", name, str(path)],
                pg_env(url, database=name),
                stage="pg_restore",
            )
            restored = create_engine(url.set(database=name))
            try:
                with restored.connect() as c:
                    actual = sql_counts(c)
            finally:
                restored.dispose()
        finally:
            if created:
                with admin.connect() as c:
                    c.execute(text(f'DROP DATABASE "{name}"'))
            admin.dispose()
    else:
        raise ValueError("Unknown backup backend")
    if actual != record["counts"]:
        raise ValueError("Restored table counts differ from backup snapshot")
    return {"verified": True, "backend": record["backend"], "tables": len(actual), "counts": actual}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("backups"))
    parser.add_argument("--restore-check", type=Path)
    args = parser.parse_args()
    if args.restore_check:
        try:
            print(json.dumps(restore_check(args.restore_check)))
        except Exception as error:
            details = {"verified": False, "error_type": type(error).__name__}
            if stage := getattr(error, "stage", None):
                details["stage"] = stage
            print(json.dumps(details))
            raise SystemExit(1) from None
        return
    name = datetime.now(UTC).strftime("alerts-%Y%m%dT%H%M%S%fZ")
    suffix = ".db" if make_url(settings.database_url).get_backend_name() == "sqlite" else ".dump"
    destination = args.directory / (name + suffix)
    try:
        report = backup(destination)
    except Exception as error:
        details = {"error_type": type(error).__name__}
        if stage := getattr(error, "stage", None):
            details["stage"] = stage
        try:
            with transaction() as db:
                db.add(Audit(kind="backup_failed", details=details))
        except Exception:
            pass
        print(json.dumps({"completed": False, **details}))
        raise SystemExit(1) from None
    with transaction() as db:
        db.add(
            Audit(
                kind="backup_completed",
                details={
                    "file": str(destination.resolve()),
                    "backend": report["backend"],
                    "sha256": report["sha256"],
                    "bytes": report["bytes"],
                    "compress": report["compress"],
                    "counts_ms": report["counts_ms"],
                    "dump_ms": report["dump_ms"],
                    "list_ms": report["list_ms"],
                    "sha256_ms": report["sha256_ms"],
                },
            )
        )
    print(json.dumps({"file": str(destination), **report}))


if __name__ == "__main__":
    main()
