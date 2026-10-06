"""Verify real pg_dump/pg_restore using only this task's dedicated Compose DB.

The source must be chart_alerts_acceptance; restoration always uses a fresh
random DB on that same task-owned pg container. No workers attach to the restore.
"""

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import uuid

from alerts.storage import (
    AgentCredential,
    AgentOperation,
    ChartAlert,
    ChartAlertAction,
    ChartAlertVersion,
    Notification,
    Outbox,
    SignalRow,
)
from chart_alert_acceptance_environment import COMPOSE, DATABASE, PROJECT, ROOT
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url


def docker(*args, **options):
    return subprocess.run(
        ["sg", "docker", "-c", shlex.join(["docker", *args])],
        check=True,
        capture_output=True,
        timeout=90,
        **options,
    )


def pg(*args, **options):
    return docker(
        "compose",
        "--env-file",
        str(ROOT / "compose.env"),
        "-p",
        PROJECT,
        "-f",
        str(COMPOSE),
        "exec",
        "-T",
        "pg",
        *args,
        **options,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-host", required=True)
    args = parser.parse_args()
    ownership = (
        docker(
            "inspect",
            "--format",
            '{{index .Config.Labels "com.docker.compose.project"}}',
            PROJECT + "-pg-1",
        )
        .stdout.decode()
        .strip()
    )
    if ownership != PROJECT:
        raise ValueError("PostgreSQL container ownership mismatch")
    values = dict(
        line.split("=", 1) for line in (ROOT / "api.env").read_text().splitlines() if "=" in line
    )
    url = make_url(values["ALERTS_DATABASE_URL"]).set(host=args.database_host)
    if url.database != DATABASE or url.username != DATABASE:
        raise ValueError("Refusing any other source database")
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    restored_name = "chart_alerts_restore_" + uuid.uuid4().hex
    path = ROOT / (restored_name + ".dump")
    restored = None
    created = False
    tables = (ChartAlert, ChartAlertVersion, SignalRow, Notification, Outbox)
    if PROJECT == "mw-chart-alerts-integration":
        tables += (AgentCredential, AgentOperation, ChartAlertAction)

    def contents(db):
        with db.connect() as connection:
            return {
                model.__tablename__: [
                    dict(row)
                    for row in connection.execute(
                        select(model.__table__).order_by(*model.__table__.primary_key.columns)
                    ).mappings()
                ]
                for model in tables
            }

    try:
        # Caller stops only task writer services before snapshotting; read-only
        # API access and sessions cannot change these five alert tables.
        expected = contents(engine)
        if not expected["signals"] or not expected["chart_alerts"]:
            raise ValueError("Backup must include populated chart alerts and events")
        payload = pg(
            "pg_dump",
            "-U",
            DATABASE,
            "-d",
            DATABASE,
            "--format=custom",
            "--no-owner",
        ).stdout
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as file:
            file.write(payload)
        pg("pg_restore", "--list", input=payload)
        with engine.connect() as connection:
            connection.execute(text('CREATE DATABASE "' + restored_name + '" TEMPLATE template0'))
            created = True
        pg(
            "pg_restore",
            "-U",
            DATABASE,
            "--dbname",
            restored_name,
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            input=payload,
        )
        restored = create_engine(url.set(database=restored_name))
        assert contents(restored) == expected, (
            "Restored rules, versions, evidence, checkpoints, or outbox differ"
        )
        with restored.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
                "s20_chart_alerts"
                if PROJECT == "mw-chart-alerts-acceptance"
                else "u22_chart_alert_actions"
            )
        result = {
            "verified": True,
            "postgres_version": pg("postgres", "--version").stdout.decode().strip(),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "alert_table_counts": {name: len(rows) for name, rows in expected.items()},
            "full_alert_payloads_equal": True,
            "migration_head": "s20_chart_alerts"
            if PROJECT == "mw-chart-alerts-acceptance"
            else "u22_chart_alert_actions",
            "temporary_restore_database_removed": True,
        }
    finally:
        if restored:
            restored.dispose()
        if created:
            with engine.connect() as connection:
                connection.execute(text('DROP DATABASE "' + restored_name + '"'))
        engine.dispose()
    (ROOT / "postgres-backup-restore.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
