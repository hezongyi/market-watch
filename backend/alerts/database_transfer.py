"""Copy a verified SQLite backup into an empty, migrated PostgreSQL database.

Workers must remain stopped on the destination until verification and cutover finish.
"""

import hashlib
import json
import sqlite3
from decimal import Decimal
from pathlib import Path

from sqlalchemy import Integer, create_engine, func, select, text

from .backup import restore_check
from .storage import Base


def fingerprint(connection, table):
    digest = hashlib.sha256()
    count = 0
    for row in connection.execute(select(table).order_by(*table.primary_key.columns)):
        values = []
        for value in row:
            if isinstance(value, Decimal):
                value = {"decimal": str(value)}
            elif isinstance(value, bytes):
                value = {"bytes": value.hex()}
            values.append(value)
        digest.update(json.dumps(values, sort_keys=True, separators=(",", ":")).encode())
        digest.update(b"\n")
        count += 1
    return {"count": count, "sha256": digest.hexdigest()}


def transfer(backup: Path, target):
    """Target is an Engine; credentials must not be printed or passed in CLI arguments."""
    if target.dialect.name != "postgresql":
        raise ValueError("Destination must be PostgreSQL")
    backup = backup.resolve()
    restore_check(backup)
    source = create_engine(
        "sqlite://",
        creator=lambda: sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True),
    )
    tables = Base.metadata.sorted_tables
    try:
        with source.connect() as src, target.begin() as dst:
            # A migrated destination is required, never bootstrap seed data here.
            version = src.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            if dst.execute(text("SELECT version_num FROM alembic_version")).scalar_one() != version:
                raise ValueError("Migration versions differ")
            for table in tables:
                dst.execute(text(f'LOCK TABLE "{table.name}" IN ACCESS EXCLUSIVE MODE'))
            for table in tables:
                if dst.scalar(select(func.count()).select_from(table)):
                    raise ValueError("Destination contains business data; refusing overwrite")
            report = {}
            for table in tables:
                rows = src.execute(select(table)).mappings()
                while batch := rows.fetchmany(1000):
                    dst.execute(table.insert(), [dict(row) for row in batch])
                expected = fingerprint(src, table)
                if fingerprint(dst, table) != expected:
                    raise ValueError(f"Copied data verification failed: {table.name}")
                report[table.name] = expected
            for table in tables:
                for column in table.primary_key.columns:
                    if isinstance(column.type, Integer):
                        sequence = dst.scalar(
                            text("SELECT pg_get_serial_sequence(:tbl, :col)"),
                            {"tbl": table.name, "col": column.name},
                        )
                        if sequence:
                            maximum = dst.scalar(select(func.max(column)))
                            dst.execute(
                                text("SELECT setval(CAST(:seq AS regclass), :value, :called)"),
                                {
                                    "seq": sequence,
                                    "value": maximum or 1,
                                    "called": maximum is not None,
                                },
                            )
            return {"verified": True, "migration": version, "tables": report}
    finally:
        source.dispose()
