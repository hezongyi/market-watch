"""Private backups and restore verification, without delivery or market workers."""

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
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


def pg_tool(name, args, env):
    executable = str(Path(settings.postgres_bin_dir) / name)
    result = subprocess.run([executable, *args], env=env, capture_output=True, timeout=900)
    if result.returncode:
        # Server diagnostics can contain connection details. Keep them out of the UI/log.
        raise RuntimeError(f"{name} failed with exit status {result.returncode}")


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
    try:
        if backend == "sqlite":
            with (
                sqlite3.connect(
                    Path(url.database).resolve().as_uri() + "?mode=ro", uri=True
                ) as source,
                sqlite3.connect(destination) as target,
            ):
                source.backup(target)
            counts = sqlite_counts(destination)
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
                    counts = sql_counts(connection)
                    pg_tool(
                        "pg_dump",
                        [
                            "--format=custom",
                            "--no-owner",
                            "--snapshot",
                            snapshot,
                            "--file",
                            str(destination),
                        ],
                        pg_env(url),
                    )
                pg_tool("pg_restore", ["--list", str(destination)], pg_env(url))
            finally:
                engine.dispose()
        record = {
            "format": 1,
            "backend": backend,
            "created_at": now_ms(),
            "sha256": sha256(destination),
            "bytes": destination.stat().st_size,
            "counts": counts,
        }
        private_file(manifest)
        owns_manifest = True
        manifest.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        return record
    except Exception:
        destination.unlink(missing_ok=True)
        if owns_manifest:
            manifest.unlink(missing_ok=True)
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
            print(json.dumps({"verified": False, "error_type": type(error).__name__}))
            raise SystemExit(1) from None
        return
    name = datetime.now(UTC).strftime("alerts-%Y%m%dT%H%M%S%fZ")
    suffix = ".db" if make_url(settings.database_url).get_backend_name() == "sqlite" else ".dump"
    destination = args.directory / (name + suffix)
    try:
        report = backup(destination)
    except Exception as error:
        try:
            with transaction() as db:
                db.add(Audit(kind="backup_failed", details={"error_type": type(error).__name__}))
        except Exception:
            pass
        print(json.dumps({"completed": False, "error_type": type(error).__name__}))
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
                },
            )
        )
    print(json.dumps({"file": str(destination), **report}))


if __name__ == "__main__":
    main()
