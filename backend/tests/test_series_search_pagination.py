"""Catalog overflow stays reachable, qualified and pure across source/day phases."""

import uuid

from alerts import api, market_data
from alerts.market_datasets import register_dataset
from alerts.series_access import search_page
from alerts.storage import (
    DatasetMaintenance,
    HistoryArtifact,
    HistoryReclamation,
    HistoryVersion,
    MarketComposite,
    MarketDemand,
)
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from test_market_contracts import identity


def large_catalog(factory, count=260):
    with factory.begin() as db:
        for index in range(count):
            source = "oanda" if index % 2 else "dukascopy"
            phase = "utc0" if index % 3 else "ny17"
            code = f"S{index:04}USD"
            native = identity(
                provider_symbol=code,
                calendar_version=phase + "-v1",
                **(
                    {
                        "source": "oanda",
                        "channel": "v20",
                        "environment": "practice",
                        "account_scope": "sha256:" + "a" * 64,
                    }
                    if source == "oanda"
                    else {}
                ),
            )
            register_dataset(
                db,
                native,
                logical_symbol=code,
                label=code,
                calendar=phase,
                precision=5,
                volume_kind="price_count" if source == "oanda" else "quantity",
                volume_unit="quotes" if source == "oanda" else "source_quantity",
            )
            version = HistoryVersion(
                id=str(uuid.uuid4()),
                dataset_id=native.key,
                start=0,
                end=172920000,
                cursor=172920000,
                status="published",
                published_at=index + 1,
                manifest={"checksum": "a" * 64},
            )
            db.add(version)
            db.flush()
            db.add(
                HistoryArtifact(
                    id=uuid.uuid4().hex * 2,
                    version_id=version.id,
                    timeframe="M1",
                    rule_version="test",
                    cursor=version.end,
                    count=4,
                    complete_count=4,
                    status="published",
                    manifest={},
                )
            )
        db.flush()


def test_large_history_pages_no_duplicates_loss_or_source_starvation(database):
    large_catalog(database)
    ids, offset = [], 0
    with database.begin() as db:
        while True:
            page = search_page(db, page_size=25, offset=offset)
            assert len(page["items"]) <= 25
            if offset == 0:
                assert {r["historical_source"] for r in page["items"]} == {"oanda", "dukascopy"}
            ids += [r["dataset_id"] for r in page["items"]]
            if page["next_offset"] is None:
                break
            assert page["next_offset"] > offset
            offset = page["next_offset"]
        assert len(ids) == len(set(ids)) == 260
        filtered = search_page(db, source="oanda", calendar="utc0", page_size=250)
        assert filtered["items"] and all(
            r["historical_source"] == "oanda" and r["calendar"] == "utc0" for r in filtered["items"]
        )
        assert search_page(db, query="S0259", page_size=1)["items"][0]["symbol"] == "S0259USD"
        assert search_page(db, query="%", page_size=1)["items"] == []
        assert search_page(db, query="_", page_size=1)["items"] == []
        assert (
            db.scalar(select(MarketComposite)) is None and db.scalar(select(MarketDemand)) is None
        )


def test_latest_usable_artifact_skips_unpublished_and_reclaimed_versions(database):
    large_catalog(database, count=1)
    with database.begin() as db:
        original = db.scalar(select(HistoryVersion))
        for index in (2, 3):
            v = HistoryVersion(
                id=str(uuid.uuid4()),
                dataset_id=original.dataset_id,
                start=0,
                end=172920000,
                cursor=172920000,
                status="published",
                published_at=index,
                manifest={"checksum": "b" * 64},
            )
            db.add(v)
            db.flush()
            if index == 3:
                db.add(
                    HistoryArtifact(
                        id=uuid.uuid4().hex * 2,
                        version_id=v.id,
                        timeframe="M1",
                        rule_version="test",
                        cursor=v.end,
                        count=4,
                        complete_count=4,
                        status="published",
                        manifest={},
                    )
                )
                db.add(HistoryReclamation(version_id=v.id, request_id="test", reclaimed_at=1))
        db.flush()
        assert search_page(db)["items"][0]["id"] == original.id
        db.add(
            DatasetMaintenance(
                dataset_id=original.dataset_id,
                archived=True,
                target_start=0,
                timeframes=["M1"],
                next_at=0,
            )
        )
        db.flush()
        assert search_page(db)["items"] == []


def test_page_reads_only_selected_metadata_and_http_is_authenticated(database):
    large_catalog(database)
    statements = []
    engine = database.kw["bind"]

    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        with database.begin() as db:
            assert len(search_page(db, page_size=5)["items"]) == 5
        assert len(statements) <= 1 + 7 * 5
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    with TestClient(api.app) as client:
        assert client.get("/api/market-data/series/page").status_code == 401
        api.app.dependency_overrides[api.authenticated] = lambda: "test"
        try:
            response = client.get(
                "/api/market-data/series/page?kind=history&page_size=5&offset=250"
            )
            assert response.status_code == 200 and len(response.json()["items"]) == 5
            assert client.get("/api/market-data/series/page?offset=-1").status_code == 422
            assert client.get("/api/market-data/series/page?source=bad").status_code == 422
        finally:
            api.app.dependency_overrides.clear()


def test_provider_pages_reach_full_directory_and_mixed_kind_fairness(database, monkeypatch):
    large_catalog(database, count=2)
    provider = [
        {
            "id": f"OANDA:T{i:04}",
            "symbol": f"T{i:04}",
            "source": "oanda",
            "label": f"Ticker{i}",
            "available": True,
            "supported": True,
        }
        for i in range(600)
    ]
    monkeypatch.setattr(market_data, "instrument_catalog", lambda query, limit=None: provider)
    first = market_data.search_series_page(kind="provider", page_size=250)
    second = market_data.search_series_page(
        kind="provider", page_size=250, offset=first["next_offset"]
    )
    third = market_data.search_series_page(
        kind="provider", page_size=250, offset=second["next_offset"]
    )
    assert first["total"] == 600 and third["next_offset"] is None
    assert len({r["id"] for p in (first, second, third) for r in p["items"]}) == 600
    mixed = market_data.search_series(kind="all", limit=6)
    assert any(r["series_kind"] == "history" for r in mixed)
    assert any(r["series_kind"] == "provider" for r in mixed)


def test_composite_pages_use_known_mapping_without_scanning_other_products(database, monkeypatch):
    from alerts.composite_definitions import first_use
    from alerts.storage import CompositeRevision, RealtimeMapping
    from test_series_access import fixture

    fixture(database, monkeypatch)
    with database.begin() as db:
        original = db.scalar(select(RealtimeMapping))
        for index in range(55):
            db.add(
                RealtimeMapping(
                    id=f"{index:064x}",
                    dataset_id=original.dataset_id,
                    target_dataset_id=original.target_dataset_id,
                    permission_scope="workspace:default",
                    match=original.match,
                    created_at=index + 1,
                )
            )
        db.flush()
    monkeypatch.setattr(
        "alerts.series_access.composite_definition",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("Search must use its qualified mapping directly")
        ),
    )
    with database.begin() as db:
        first = search_page(db, kind="composite", page_size=25)
        second = search_page(db, kind="composite", page_size=25, offset=first["next_offset"])
        third = search_page(db, kind="composite", page_size=25, offset=second["next_offset"])
        rows = first["items"] + second["items"] + third["items"]
        assert len({r["id"] for r in rows}) == 56
        assert third["next_offset"] is None
        assert db.scalar(select(MarketComposite)) is None
        selected = first_use(db, original.dataset_id, original.id)
        old = db.get(CompositeRevision, selected.active_revision_id)
        replacement_mapping_id = f"{0:064x}"
        changed = CompositeRevision(
            composite_id=selected.id,
            history_version_id=old.history_version_id,
            mapping_id=replacement_mapping_id,
            seam=old.seam,
            rules={**old.rules, "aggregation_calendar": "utc0"},
            request_id="changed",
        )
        db.add(changed)
        db.flush()
        selected.active_revision_id = changed.id
        db.flush()
        utc = search_page(db, kind="composite", calendar="utc0", page_size=250)
        assert [r["id"] for r in utc["items"]] == [selected.id]
        assert utc["items"][0]["mapping_id"] == replacement_mapping_id
        ny = search_page(db, kind="composite", calendar="ny17", page_size=250)
        assert len(ny["items"]) == 55
