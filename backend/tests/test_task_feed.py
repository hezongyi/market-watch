"""Dynamic task browsing must not skip or reorder records while states change."""

from uuid import UUID

import pytest
from alerts import api
from alerts.data_center import task_feed, task_list
from alerts.storage import HistoryVersion, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_market_contracts import identity
from test_market_datasets import register


def seed(db):
    register(db)
    for index in range(7):
        db.add(
            HistoryVersion(
                id=str(UUID(int=index + 1)),
                dataset_id=identity().key,
                start=0,
                end=120000,
                cursor=0,
                status="pending",
                created_at=1000 + index // 2,
            )
        )
    db.flush()


def test_keyset_keeps_equal_times_and_new_task_out_of_loaded_snapshot(database):
    with database.begin() as db:
        seed(db)
        first = task_feed(db, page_size=2, status="active")
        snapshot = first["snapshot"]
        loaded = [row["id"] for row in first["items"]]
        db.add(
            HistoryVersion(
                id=str(UUID(int=100)),
                dataset_id=identity().key,
                start=0,
                end=120000,
                cursor=0,
                status="pending",
                created_at=snapshot + 1,
            )
        )
        # The first loaded row may change state, but must not shift continuation.
        db.get(HistoryVersion, loaded[0]).status = "cancelled"
        db.flush()
        page = first
        while page["next_cursor"]:
            page = task_feed(
                db, page_size=2, status="active", snapshot=snapshot, before=page["next_cursor"]
            )
            loaded.extend(row["id"] for row in page["items"])
            assert page["new_count"] == 1
        assert len(loaded) == len(set(loaded)) == 7
        assert str(UUID(int=100)) not in loaded
        updates = task_feed(db, ids=",".join(loaded))
        assert [row["id"] for row in updates["items"]] == loaded
        assert updates["items"][0]["status"] == "cancelled"
        assert db.scalar(select(MarketDemand)) is None


def test_feed_filters_and_legacy_page_remain_compatible(database):
    with database.begin() as db:
        seed(db)
        assert (
            task_feed(db, query="EUR/USD", source="dukascopy", dataset_id=identity().key)["total"]
            == 7
        )
        assert task_feed(db, query="%", status="all")["items"] == []
        assert task_feed(db, source="yahoo")["items"] == []
        assert task_list(db, page_size=2)["total"] == 7
        for kwargs in [
            {"before": "invalid"},
            {"before": "1:invalid"},
            {"snapshot": -1},
            {"ids": "invalid"},
            {"page_size": 101},
            {"status": "invalid"},
        ]:
            with pytest.raises(ValueError):
                task_feed(db, **kwargs)


def test_authenticated_feed_validation_and_id_polling(database):
    with database.begin() as db:
        seed(db)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            first = client.get("/api/market-data/center/task-feed?page_size=2&status=active")
            assert first.status_code == 200 and len(first.json()["items"]) == 2
            ident = first.json()["items"][0]["id"]
            assert (
                client.get(f"/api/market-data/center/task-feed?ids={ident}").json()["items"][0][
                    "id"
                ]
                == ident
            )
            assert client.get("/api/market-data/center/task-feed?before=bad").status_code == 422
            assert client.get("/api/market-data/center/task-feed?snapshot=-1").status_code == 422
    finally:
        api.app.dependency_overrides.clear()
