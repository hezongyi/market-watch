"""Reviewed targets must not expand or gain references before deletion."""

import pytest
from alerts import api
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import create_run
from alerts.history_retention import ReclamationConflict, reclaim, references
from alerts.history_versions import import_page, snapshot_rows
from alerts.storage import ChartWorkspace, HistoryVersion
from fastapi.testclient import TestClient
from test_history_maintenance import Adapter
from test_history_retention import prepared
from test_market_contracts import identity


def test_impact_reports_exact_versions_periods_and_unique_shared_content(database):
    ident, _ = prepared(database)
    with database.begin() as db:
        view = references(db, identity().key)
        impact = view["impact"]
        assert impact["dataset"]["identity"] == identity().model_dump()
        assert impact["dataset"]["logical_symbol"] == "EURUSD"
        target = impact["versions"][0]
        assert (target["version_id"], target["start"], target["end"]) == (ident, 0, 120000)
        assert {p["timeframe"] for p in target["periods"]} == {"M1", "H4"}
        assert target["disposition"] == "delete_payload"
        totals = impact["payload_totals"]
        assert totals["period_payload_bytes"] > 0 and totals["unique_source_payload_bytes"] > 0
        assert totals["retained_shared_source_blobs"] == 1
        assert totals["retained_shared_source_payload_bytes"] == totals["unique_source_payload_bytes"]
        assert totals["currently_unreferenced_source_payload_bytes"] == 0
        token = impact["review_revision"]
        assert references(db, identity().key)["impact"]["review_revision"] == token
        result = reclaim(db, identity().key, "reviewed-clear", expected_review_revision=token)
    with database.begin() as db:
        after = references(db, identity().key)["impact"]
        assert after["payload_totals"]["target_versions"] == 0
        assert after["versions"][0]["disposition"] == "already_reclaimed"
        assert reclaim(db, identity().key, "reviewed-clear", expected_review_revision=token) == result


def test_new_publication_invalidates_review_without_expanding_deletion(database):
    old, _ = prepared(database)
    with database.begin() as db:
        token = references(db, identity().key)["impact"]["review_revision"]
        # The test deliberately publishes after review using the existing worker
        # contract; plan remains paused/archived, as an in-flight completion can.
        from alerts.storage import DatasetMaintenance
        db.get(DatasetMaintenance, identity().key).archived = False
        child = create_run(db, identity().key, end=180000, request_id="after-review").id
        db.get(DatasetMaintenance, identity().key).archived = True
    while import_page(Adapter(), version_id=child):
        pass
    while artifact_tick(child):
        pass
    with database.begin() as db:
        with pytest.raises(ReclamationConflict, match="影响或引用已变化") as error:
            reclaim(db, identity().key, "stale", expected_review_revision=token)
        assert error.value.report["impact"]["payload_totals"]["target_versions"] == 2
        assert len(list(snapshot_rows(db, old))) == 2
        assert len(list(snapshot_rows(db, child))) == 3


def test_http_conflict_returns_new_dependency_and_preserves_prices(database):
    ident, instrument = prepared(database)
    with database.begin() as db:
        token = references(db, identity().key)["impact"]["review_revision"]
        workspace = ChartWorkspace(name="new after review", document={"instrument": instrument, "version_id": ident})
        db.add(workspace)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            response = client.post(f"/api/market-data/datasets/{identity().key}/reclaim",
                json={"request_id": "stale-reference", "expected_review_revision": token})
            assert response.status_code == 409
            result = response.json()["detail"]
            assert result["code"] == "RECLAMATION_CHANGED"
            assert result["references"]["items"][0]["kind"] == "workspace"
            assert result["references"]["impact"]["versions"][0]["disposition"] == "protected"
    finally:
        api.app.dependency_overrides.clear()
    with database.begin() as db:
        assert db.get(HistoryVersion, ident).status == "published"
        assert len(list(snapshot_rows(db, ident))) == 2
