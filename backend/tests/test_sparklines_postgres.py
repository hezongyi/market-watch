"""A sparkline cache read must leave connections available for page navigation."""

import os

import pytest
from alerts import provider_cache, provider_chart, sparklines, storage
from alerts.storage import ProviderBar
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from test_provider_postgres import provider_pg as provider_pg
from test_sparklines import catalog, read, stamp

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


def test_provider_read_finishes_with_one_available_connection(provider_pg, monkeypatch):
    _, isolated = provider_pg
    with isolated.connect() as connection:
        schema = connection.scalar(text("select current_schema()"))
    limited = create_engine(isolated.url, connect_args={"options": f"-csearch_path={schema}"},
        pool_size=1, max_overflow=0, pool_timeout=0.2)
    factory = sessionmaker(limited, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    now = stamp("2026-11-13T00:10:30+00:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    left, _ = sparklines.window(now, None)
    try:
        with factory.begin() as db:
            catalog(db)
        meta = provider_chart.metadata("TEST", cached_only=True)
        key = provider_cache.ensure(meta, "M1")
        with factory.begin() as db:
            for at in (left - 60000, left, left + 60000):
                db.add(ProviderBar(dataset_id=key, start=at, chart_time=at, complete=True,
                    observed_at=at, payload={"start": at, "end": at + 60000,
                        "close": "123.45678901", "complete": True}))
        result = read("MWP:TEST")[0]
        assert result["status"] != "unavailable", result["reason"]
        assert result["previous_close_price"] == "123.45678901"
        assert len(result["points"]) == 2
    finally:
        limited.dispose()
