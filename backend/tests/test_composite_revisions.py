"""Explicit preparation and fenced activation preserve fixed running inputs."""

import pytest
from alerts.chart_data import FRAMES
from alerts.composite_chart import chart_page
from alerts.composite_revisions import activate, create, preparation_tick, report
from alerts.storage import (
    ChartAlert,
    CompositeActivation,
    CompositePreparation,
    CompositeRevision,
    CompositeRevisionChange,
    HistoryArtifact,
    HistoryVersion,
    MarketComposite,
    MarketDemand,
    RealtimeMapping,
)
from sqlalchemy import func, select
from test_composite_aggregates import drain
from test_composite_chart import populated


def request(database, monkeypatch, **changes):
    composite, old, seam = populated(database, monkeypatch)
    from test_composite_alerts import aggregate, live
    live(database, old, 200000000, seam + 600000)
    aggregate(old, "M1")
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: 200010000)
    with database() as db:
        revision = db.get(CompositeRevision, old)
        body = {"request_id": "revision-test", "expected_revision_id": old,
            "history_version_id": revision.history_version_id, "mapping_id": revision.mapping_id,
            "seam": seam + 60000, "allow_non_day_boundary": True, "reason": "明确新的分钟拼接规则", **changes}
    return composite, old, body


def prepared(database, ident):
    from alerts.history_artifacts import artifact_tick

    with database() as db:
        version = db.get(CompositeRevision, ident).history_version_id
    while artifact_tick(version):
        pass
    # Controlled finite query completion: do not claim supplier coverage.
    with database.begin() as db:
        prep = db.get(CompositePreparation, ident)
        prep.status, prep.cursor = "queried", prep.cutoff
    preparation_tick()
    for frame in FRAMES:
        drain(ident, frame)
    preparation_tick()


def test_preparation_is_idempotent_pure_reads_and_atomic_activation(database, monkeypatch):
    composite, old, body = request(database, monkeypatch)
    with database.begin() as db:
        revision = create(db, composite, body)
        ident = revision.id
        assert create(db, composite, body).id == ident
        assert db.get(MarketComposite, composite).active_revision_id == old
        assert db.scalar(select(MarketDemand)) is None
        count = db.scalar(select(func.count()).select_from(HistoryArtifact))
        progress = report(db, composite, ident)
        assert not progress["preparation"]["ready"]
        assert progress["change"]["policy"] == "no_implicit_rule_migration"
        assert db.scalar(select(func.count()).select_from(HistoryArtifact)) == count
        with pytest.raises(ValueError, match="尚未完成"):
            activate(db, composite, ident, {"request_id": "activate-test", "expected_revision_id": old})
    prepared(database, ident)
    with database.begin() as db:
        assert report(db, composite, ident)["preparation"]["ready"]
        previous = chart_page(db, composite, "M1", revision_id=old, now=200010000)
        activation = activate(db, composite, ident, {"request_id": "activate-test", "expected_revision_id": old})
        assert activation.event_boundary % 60000 == 0
        assert activate(db, composite, ident, {"request_id": "activate-test", "expected_revision_id": old}) is activation
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert chart_page(db, composite, "M1", revision_id=old, now=200010000) == previous
        assert create(db, composite, body).id == ident  # lost response retry after activation
        with pytest.raises(ValueError, match="不同参数"):
            create(db, composite, {**body, "reason": "不同修订参数"})
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(CompositeRevisionChange, ident).reason = "rewrite evidence"
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(CompositeActivation, ident).event_boundary += 60000


def test_non_day_boundary_and_concurrent_activation_are_explicit(database, monkeypatch):
    composite, old, body = request(database, monkeypatch)
    with database.begin() as db:
        with pytest.raises(ValueError, match="非日界"):
            create(db, composite, {**body, "allow_non_day_boundary": False})
        first = create(db, composite, body).id
        second = create(db, composite, {**body, "request_id": "other-test", "seam": body["seam"] + 60000}).id
    prepared(database, first)
    prepared(database, second)
    with database.begin() as db:
        activate(db, composite, first, {"request_id": "first-activate", "expected_revision_id": old})
        with pytest.raises(ValueError, match="并发切换"):
            activate(db, composite, second, {"request_id": "second-activate", "expected_revision_id": old})
        assert db.get(MarketComposite, composite).active_revision_id == first
        assert db.get(CompositeActivation, second) is None


def test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity(database, monkeypatch):
    from alerts.aggregation_policy import change_aggregation
    from alerts.chart_alert_service import create as create_alert
    from alerts.chart_alert_service import current_version
    from alerts.chart_query import DataQuery
    from alerts.composite_definitions import first_use, save_mapping
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import import_page
    from alerts.market_usage import composite_targets
    from alerts.series_access import chart_data, metadata
    from test_composite_alerts import config
    from test_composite_definitions import PROOF
    from test_history_versions import Adapter

    composite, old, body = request(database, monkeypatch)
    with database.begin() as db:
        parent = db.get(HistoryVersion, body["history_version_id"])
        original_dataset = parent.dataset_id
        destination, _, derived = change_aggregation(db, parent.dataset_id, "utc0", version_id=parent.id)
        new_dataset, new_version = destination.id, derived.id
        old_rule = create_alert(db, "pinned-old-rule", config(composite), at=200000000).id
        saved = dict(current_version(db, db.get(ChartAlert, old_rule)).market_identity)
    while import_page(Adapter([]), version_id=new_version):
        with database() as db:
            if db.get(HistoryVersion, new_version).status == "published":
                break
    while artifact_tick(new_version):
        pass
    with database.begin() as db:
        from alerts.storage import MarketCatalog

        catalog = db.scalar(select(MarketCatalog.id).where(MarketCatalog.source == "oanda"))
        mapping = save_mapping(db, new_dataset, catalog, PROOF)
        ident = create(db, composite, {**body, "history_version_id": new_version,
            "mapping_id": mapping.id, "seam": 86400000, "allow_non_day_boundary": False}).id
    prepared(database, ident)
    with database.begin() as db:
        activate(db, composite, ident, {"request_id": "utc-activation", "expected_revision_id": old})
        assert db.get(MarketComposite, composite).dataset_id == original_dataset
        assert metadata(db, composite, "composite")["calendar"] == "utc0"
        page = chart_data(db, DataQuery(instrument=composite, series_kind="composite", timeframe="M1", client="existing-chart"))
        assert page["revision_id"] == ident and page["calendar"] == "utc0"
        assert db.scalar(select(func.count()).select_from(MarketComposite)) == 1
        old_page = chart_data(db, DataQuery(instrument=composite, series_kind="composite", timeframe="D1",
            composite_revision_id=old))
        assert old_page["calendar"] == "ny17"
        assert current_version(db, db.get(ChartAlert, old_rule)).market_identity == saved
        internal = db.get(MarketComposite, composite).instrument_id
        assert db.get(RealtimeMapping, mapping.id).target_dataset_id in composite_targets(db, {internal})
        # Reopening the original candidate still shares the same stable composite.
        assert first_use(db, original_dataset, body["mapping_id"]).id == composite


def test_captured_indicator_warmup_must_finish_before_activation(database, monkeypatch):
    from alerts.chart_alert_service import create as create_alert
    from alerts.fixed_indicators import indicator_tick
    from test_composite_alerts import config

    composite, old, body = request(database, monkeypatch)
    with database.begin() as db:
        rule = create_alert(db, "indicator-source", config(composite, condition={
            "relation": "cross_up", "left": {"kind": "indicator", "indicator": {
                "name": "EMA", "version": "1", "params": {"period": 3}, "output": "value"}},
            "right": {"kind": "constant", "value": "1.2"}}), at=200000000)
        ident = create(db, composite, body).id
        assert db.get(CompositeRevisionChange, ident).manifest["affected_rules"][0]["id"] == rule.id
    prepared(database, ident)
    with database.begin() as db:
        progress = report(db, composite, ident)
        assert progress["preparation"]["status"] == "initializing_indicators"
        assert progress["preparation"]["indicators"][0]["run_id"]
        with pytest.raises(ValueError, match="尚未完成"):
            activate(db, composite, ident, {"request_id": "indicator-activation", "expected_revision_id": old})
    while indicator_tick():
        pass
    with database.begin() as db:
        assert report(db, composite, ident)["preparation"]["ready"]
        activate(db, composite, ident, {"request_id": "indicator-activation", "expected_revision_id": old})


def test_authenticated_revision_contract_and_pure_options(database, monkeypatch):
    from alerts import api
    from fastapi.testclient import TestClient

    composite, old, body = request(database, monkeypatch)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            base = "/api/market-data/composites/" + composite
            before = client.get(base + "/revisions").json()["total"]
            choice = client.get(base + "/revision-options")
            assert choice.status_code == 200 and choice.json()["items"]
            with database() as db:
                assert db.scalar(select(MarketDemand)) is None
            created = client.post(base + "/revisions", json=body)
            assert created.status_code == 201, created.text
            ident = created.json()["id"]
            assert client.post(base + "/revisions", json=body).json()["id"] == ident
            assert client.get(base + "/revisions?request_id=" + body["request_id"]).json()["items"][0]["id"] == ident
            assert client.get(base + "/revisions?request_id=missing").json()["items"] == []
            assert client.get(base + "/revisions/" + ident).json()["id"] == ident
            assert client.get(base + "/revisions").json()["total"] == before + 1
            assert client.post(base + "/revisions/" + ident + "/activate", json={
                "request_id": "http-activation", "expected_revision_id": old}).status_code == 422
            prepared(database, ident)
            activated = client.post(base + "/revisions/" + ident + "/activate", json={
                "request_id": "http-activation", "expected_revision_id": old})
            assert activated.status_code == 200, activated.text
            assert activated.json()["activation"]["previous_revision_id"] == old
            assert client.get(base).json()["active_revision_id"] == ident
    finally:
        api.app.dependency_overrides.clear()


def test_pending_revision_polling_rotates_past_twenty_waiting_tasks(database, monkeypatch):
    composite, _, body = request(database, monkeypatch)
    ids = []
    with database.begin() as db:
        for index in range(21):
            ids.append(create(db, composite, {**body, "request_id": "fair-" + str(index)}).id)
    # Real epoch milliseconds exceed PostgreSQL INTEGER; fixture event times
    # used for creating revisions must not hide overflow in polling state.
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: 1791333261616)
    preparation_tick()
    with database() as db:
        visited = [ident for ident in ids if "activation_checked_at" in db.get(CompositePreparation, ident).state]
        assert len(visited) == 20
    preparation_tick()
    with database() as db:
        assert all("activation_checked_at" in db.get(CompositePreparation, ident).state for ident in ids)
