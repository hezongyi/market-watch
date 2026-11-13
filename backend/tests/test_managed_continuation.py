"""Explicit extension selection, atomic enable and unchanged legacy identities."""

import pytest
from alerts.composite_definitions import save_mapping
from alerts.managed_continuation import configure, default_key, report
from alerts.realtime_switch import enabled
from alerts.storage import MarketComposite, MarketDataset, MarketDemand, Preference, RealtimeMapping
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity


def test_browsing_and_failed_enable_never_create_demand_or_change_switch(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        before = report(db, identity().key)
        assert before["supported"] and not before["enabled"]
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        selected = report(db, identity().key)
        assert selected["default_mapping_id"] == mapping.id
        assert not selected["ready_to_enable"]
        assert db.scalar(select(MarketComposite)) is None
        assert db.scalar(select(MarketDemand)) is None
    with pytest.raises(ValueError, match="固定M1历史"):
        with database.begin() as db:
            configure(db, identity().key, value=True)
    with database.begin() as db:
        assert db.get(Preference, default_key(identity().key)) is None
        assert not enabled(db, db.get(MarketDataset, identity().key).instrument_id)
        assert db.scalar(select(MarketComposite)) is None


def test_enable_is_idempotent_and_disable_keeps_mapping_revision_and_history(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    parent = publish(database)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        first = configure(db, identity().key, value=True, mapping_id=mapping.id)
        composite_id = first["composite"]["id"]
        revision = first["composite"]["active_revision_id"]
        assert first["enabled"] and first["ready_to_enable"]
        assert first["composite"]["revision"]["history_version_id"] == parent
        assert db.scalar(select(MarketDemand)) is None
        again = configure(db, identity().key, value=True)
        assert again["composite"]["active_revision_id"] == revision
        off = configure(db, identity().key, value=False)
        assert not off["enabled"] and off["status"] == "disabled"
        assert off["composite"]["id"] == composite_id
        assert off["composite"]["active_revision_id"] == revision
        assert db.get(RealtimeMapping, mapping.id)
        assert db.scalar(select(func.count()).select_from(MarketComposite)) == 1


def test_multiple_valid_mappings_require_explicit_choice_and_stale_default_never_falls_back(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    publish(database)
    with database.begin() as db:
        first = save_mapping(db, identity().key, catalog, PROOF)
        second = save_mapping(db, identity().key, catalog, {**PROOF, "rationale": "Another independently reviewed mapping configuration"})
        assert first.id != second.id
        row = report(db, identity().key)
        assert row["default_mapping_id"] is None and not row["ready_to_enable"]
        with pytest.raises(ValueError, match="默认实时接续配置"):
            configure(db, identity().key, value=True)
        selected = configure(db, identity().key, value=True, mapping_id=second.id)
        assert selected["default_mapping_id"] == second.id
        db.get(Preference, default_key(identity().key)).value = {"mapping_id": "f" * 64}
        db.flush()
        stale = report(db, identity().key)
        assert stale["default_mapping_id"] == "f" * 64
        assert stale["composite"] is None and not stale["ready_to_enable"]


def test_extension_api_rejects_non_boolean_choice(database, monkeypatch):
    from alerts import api
    from fastapi.testclient import TestClient

    prepare(database, monkeypatch)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            path = f"/api/market-data/datasets/{identity().key}/continuation"
            assert client.get(path).status_code == 200
            assert client.post(path, json={"enabled": "false"}).status_code == 422
            assert client.post(path, json={"enabled": True}).status_code == 422
    finally:
        api.app.dependency_overrides.clear()
