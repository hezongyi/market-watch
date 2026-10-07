"""Build an actual predecessor inside an empty, fixture-owned PostgreSQL schema."""

from alembic import command
from alerts.config import settings
from alerts.storage import Base
from sqlalchemy import func, select, text
from test_alerts_mcp_migration import configuration


def predecessor(engine, monkeypatch, revision):
    with engine.begin() as conn:
        schema = conn.scalar(text("SELECT current_schema()"))
        assert schema.startswith("provider_")
        # This helper only accepts a fresh fixture; populated migration tests
        # must preserve their rows rather than using this reset.
        assert all(conn.scalar(select(func.count()).select_from(table)) == 0
                   for table in Base.metadata.sorted_tables)
        Base.metadata.drop_all(conn)
    scoped = engine.url.update_query_dict({"options": "-csearch_path=" + schema})
    monkeypatch.setattr(settings, "database_url", scoped.render_as_string(hide_password=False))
    config = configuration()
    command.upgrade(config, revision)
    return config


def complete(config, revision):
    # The migration under test was called directly through Operations.
    command.stamp(config, revision)
    command.upgrade(config, "head")
