"""Publication comparison retains immutable inputs and does not imply price counts."""

import pytest
from alerts import api
from alerts.history_artifacts import artifact_tick
from alerts.history_comparison import report
from alerts.history_maintenance import create_run
from alerts.history_versions import import_page
from alerts.storage import HistoryReclamation, HistoryVersion, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_history_maintenance import Adapter, setup
from test_market_contracts import identity


def test_comparison_uses_fixed_parent_and_discloses_partition_limits(database):
    parent = setup(database, end=300000)
    with database.begin() as db:
        original = db.get(HistoryVersion, parent).manifest
        child = create_run(db, identity().key, kind="recheck", start=60000,
                           end=120000, request_id="comparison-recheck").id
        with pytest.raises(ValueError, match="已发布"):
            report(db, child)
    for _ in range(3):
        assert import_page(Adapter(close="1.10"), version_id=child)
    while artifact_tick(child):
        pass
    with database.begin() as db:
        data = report(db, child)
        assert data["previous"]["id"] == parent
        assert data["current"]["published_at"] is not None
        assert data["current"]["refresh_start"] == 60000
        assert data["differences"]["observed_minutes_delta"] == 0
        assert not data["differences"]["same_original_checksum"]
        assert data["differences"]["same_window_chunks"] == 0
        assert data["differences"]["nonmatching_partition_chunks"] == 3
        assert "逐分钟价格" in data["meaning"]
        assert db.get(HistoryVersion, parent).manifest == original
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
        assert report(db, parent)["previous"] is None
        with pytest.raises(ValueError, match="另一已发布"):
            report(db, child, child)
        # Retained tombstone manifests are comparable without reading payload.
        db.add(HistoryReclamation(version_id=parent, request_id="comparison-tombstone"))
    with database.begin() as db:
        assert report(db, child)["previous"]["payload_available"] is False
    with TestClient(api.app) as client:
        assert client.get(f"/api/market-data/versions/{child}/comparison").status_code == 401
        api.app.dependency_overrides[api.authenticated] = lambda: "test"
        try:
            response = client.get(f"/api/market-data/versions/{child}/comparison")
            assert response.status_code == 200
            assert response.json()["previous"]["id"] == parent
        finally:
            api.app.dependency_overrides.clear()
