"""Transfer guard and rollback checks against an isolated PostgreSQL schema."""

import os
import uuid

import pytest
from alerts import database_transfer as transfer_module
from alerts.storage import Base
from sqlalchemy import create_engine, func, select, text


def test_transfer_rolls_back_when_fingerprint_differs(tmp_path, monkeypatch):
    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Requires isolated TEST_POSTGRES_URL")
    backup = tmp_path / "source.db"
    source = create_engine(f"sqlite:///{backup}")
    Base.metadata.create_all(source)
    with source.begin() as c:
        c.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
        c.execute(text("INSERT INTO alembic_version VALUES ('test')"))
        c.execute(
            Base.metadata.tables["preferences"].insert(),
            {"key": "rollback-probe", "value": {"nested": [1, True, None]}},
        )
        c.execute(
            Base.metadata.tables["audit_events"].insert(),
            {"id": 9001, "kind": "transfer_fixture", "at": 1, "details": {}},
        )
    source.dispose()
    # Manifest verification is independently tested in test_backup; use a tiny fixture here.
    monkeypatch.setattr(transfer_module, "restore_check", lambda path: None)
    schema = "transfer_test_" + uuid.uuid4().hex
    admin = create_engine(url)
    with admin.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    target = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    try:
        Base.metadata.create_all(target)
        with target.begin() as c:
            c.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
            c.execute(text("INSERT INTO alembic_version VALUES ('test')"))
        original = transfer_module.fingerprint

        def mismatch(connection, table):
            result = original(connection, table)
            if connection.dialect.name == "postgresql" and table.name == "preferences":
                result["sha256"] = "injected mismatch"
            return result

        monkeypatch.setattr(transfer_module, "fingerprint", mismatch)
        with pytest.raises(ValueError, match="verification failed"):
            transfer_module.transfer(backup, target)
        with target.connect() as c:
            assert all(
                c.scalar(select(func.count()).select_from(t)) == 0
                for t in Base.metadata.sorted_tables
            )
        monkeypatch.setattr(transfer_module, "fingerprint", original)
        result = transfer_module.transfer(backup, target)
        assert result["tables"]["preferences"]["count"] == 1
        with target.begin() as c:
            audit = Base.metadata.tables["audit_events"]
            new_id = c.scalar(
                audit.insert().values(kind="after_transfer", at=2, details={}).returning(audit.c.id)
            )
            assert new_id == 9002
        with pytest.raises(ValueError, match="refusing overwrite"):
            transfer_module.transfer(backup, target)
    finally:
        target.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()
