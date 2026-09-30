import pytest
from alerts import storage
from sqlalchemy import create_engine
from sqlalchemy.exc import TimeoutError
from sqlalchemy.pool import QueuePool


def test_configured_pool_cannot_exceed_connection_budget(monkeypatch):
    monkeypatch.setattr(storage.settings, "database_pool_size", 2)
    monkeypatch.setattr(storage.settings, "database_max_overflow", 0)
    monkeypatch.setattr(storage.settings, "database_pool_timeout", 1)

    def local_transport(url, **options):
        # Keep the production PostgreSQL pool settings, use local DB handles so
        # exhausting the acceptance pool cannot consume shared server slots.
        assert (
            options.pop("connect_args")["application_name"]
            == storage.settings.database_application_name
        )
        return create_engine("sqlite://", poolclass=QueuePool, **options)

    monkeypatch.setattr(storage, "create_engine", local_transport)
    engine = storage.make_engine("postgresql+psycopg://unused:unused@localhost/unused")
    first, second = engine.connect(), engine.connect()
    try:
        with pytest.raises(TimeoutError):
            engine.connect()
        first.close()
        with engine.connect() as returned:
            assert returned.exec_driver_sql("select 1").scalar() == 1
    finally:
        first.close()
        second.close()
        engine.dispose()
