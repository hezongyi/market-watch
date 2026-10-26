"""Mixed persisted state: retirement is precise, repeatable and non-destructive."""

import copy
from decimal import Decimal

import httpx
import pytest
from alerts import api, notify, storage
from alerts.chart_alert_service import consume, create
from alerts.retire_legacy import retire
from alerts.service import acknowledge
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_chart_alert_service import config, sample


def old_watch(db, *, instrument="EURUSD", name="old", status="active"):
    row = storage.Watch(instrument_id=instrument, name=name, rule={"kind": "price", "timeframe": "tick", "level": "10"},
        state={"quote": "9", "quote_at": 100}, status=status, armed_at=100,
        warmup_start=10, paused_reason="historical reason")
    db.add(row)
    db.flush()
    return row


def old_event(db, watch=None, *, status="pending", lease=None, unknown=False):
    signal = storage.SignalRow(watch_id=None if unknown else watch.id, instrument_id="EURUSD",
        occurred_at=200, price=Decimal("11"), threshold=Decimal("10"), direction="up",
        reason="historical fixture", evidence={"source": "historical fixture"})
    db.add(signal)
    db.flush()
    note = storage.Notification(signal_id=signal.id)
    db.add(note)
    db.flush()
    task = storage.Outbox(notification_id=note.id, status=status, lease_until=lease, next_at=0)
    db.add(task)
    db.flush()
    return note, task


def mixed(database):
    with database.begin() as db:
        watch = old_watch(db)
        triggered = old_watch(db, name="triggered", status="triggered")
        note, task = old_event(db, watch)
        other, unknown = old_event(db, unknown=True)
        done, accepted = old_event(db, triggered, status="accepted")
        rule = create(db, "new", config(notify_ntfy=True), at=0)
        consume(db, rule.id, sample(0, 9), detected_at=0)
        consume(db, rule.id, sample(1, 11), detected_at=300001)
        new_note = db.scalar(select(storage.Notification).join(storage.SignalRow).where(storage.SignalRow.chart_alert_id == rule.id))
        return watch.id, note.id, task.id, other.id, unknown.id, done.id, accepted.id, rule.id, new_note.id


def test_preview_apply_repeat_preserve_history_and_only_cancel_legacy(database):
    watch_id, note_id, task_id, unknown_note, unknown_task, done_note, accepted, rule_id, new_note = mixed(database)
    with database.begin() as db:
        watch = db.get(storage.Watch, watch_id)
        preserved = copy.deepcopy({key: getattr(watch, key) for key in ("rule", "state", "armed_at", "warmup_start", "paused_reason")})
        preview = retire(db, at=500000)
        assert preview["counts"] == {"watches": 1, "notifications": 1}
        assert watch.status == "active" and db.get(storage.Outbox, task_id).status == "pending"
        assert db.scalar(select(func.count()).select_from(storage.Audit).where(storage.Audit.kind == "legacy_watch_retired")) == 0
    with database.begin() as db:
        applied = retire(db, apply=True, at=500000)
        assert applied["verified"]
    with database.begin() as db:
        assert retire(db, apply=True, at=600000)["counts"] == {"watches": 0, "notifications": 0}
        watch = db.get(storage.Watch, watch_id)
        assert watch.status == "cancelled"
        assert {key: getattr(watch, key) for key in preserved} == preserved
        assert db.get(storage.Notification, note_id).status == "retired"
        assert db.get(storage.Notification, note_id).ack_at is None
        assert db.get(storage.Outbox, task_id).status == "cancelled"
        assert db.get(storage.Outbox, unknown_task).status == "pending"
        assert db.get(storage.Notification, unknown_note).status == "pending"
        assert db.get(storage.Outbox, accepted).status == "accepted"
        assert db.get(storage.Notification, done_note).status == "pending"
        assert db.get(storage.ChartAlert, rule_id).count == 1
        assert db.get(storage.Notification, new_note).status == "pending"
        assert db.scalar(select(func.count()).select_from(storage.SignalRow)) == 4
        assert db.scalar(select(func.count()).select_from(storage.Audit).where(storage.Audit.kind == "legacy_watch_retired")) == 1
        # Previously issued grants may still acknowledge historical events.
        acknowledge(db, note_id)
        assert db.get(storage.Notification, note_id).ack_at is not None


def test_apply_refuses_live_claim_without_partial_retirement(database):
    with database.begin() as db:
        watch = old_watch(db)
        _, task = old_event(db, watch, status="sending", lease=600000)
        ident, task_id = watch.id, task.id
    with pytest.raises(ValueError, match="领取期"):
        with database.begin() as db:
            retire(db, apply=True, at=500000)
    with database.begin() as db:
        assert db.get(storage.Watch, ident).status == "active"
        assert retire(db, at=500000)["in_flight"] == [task_id]
        assert retire(db, apply=True, at=600001)["verified"]


def test_claim_retry_and_device_never_reactivate_legacy_or_unknown(database, monkeypatch):
    _, note_id, _, unknown_note, _, _, _, rule_id, new_note = mixed(database)
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "synthetic-never-network")
    requests = []
    client = httpx.Client(transport=httpx.MockTransport(lambda request: (requests.append(request) or httpx.Response(200, json={"id": "fixture"}))))
    assert notify.deliver_once(client)
    assert not notify.deliver_once(client)
    with database() as db:
        assert db.get(storage.Notification, new_note).status == "server_accepted"
        assert db.get(storage.ChartAlert, rule_id).count == 1
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as website:
            for ident in (note_id, unknown_note):
                assert website.post(f"/api/notifications/{ident}/retry").status_code == 410
            assert website.post("/api/watches", json={"invalid_old_schema": True}).status_code == 410
            assert website.post("/api/watches/any/cancel").status_code == 410
            assert website.post("/api/replays", json={}).status_code == 410
            assert website.post("/api/replays/any/step", json={}).status_code == 410
            assert website.post("/api/charts/workspaces", json={}).status_code == 410
    finally:
        api.app.dependency_overrides.clear()
    assert len(requests) == 1


def test_composite_watch_binding_and_history_references_survive(database, monkeypatch):
    from alerts.history_retention import references
    from test_composite_chart import populated

    composite_id, revision_id, _ = populated(database, monkeypatch)
    with database.begin() as db:
        composite = db.get(storage.MarketComposite, composite_id)
        revision = db.get(storage.CompositeRevision, revision_id)
        watch = old_watch(db, instrument=composite.instrument_id, name="old composite")
        binding = storage.CompositeWatchBinding(watch_id=watch.id, revision_id=revision.id,
            history_version_id=revision.history_version_id, market_identity={"series_kind": "composite",
                "composite_id": composite.id}, use_history=True, runtime={"saved": "evidence"})
        db.add(binding)
        db.flush()
        watch_id, dataset = watch.id, db.get(storage.HistoryVersion, revision.history_version_id).dataset_id
        original = copy.deepcopy(binding.market_identity)
        retire(db, apply=True)
    with database() as db:
        binding = db.get(storage.CompositeWatchBinding, watch_id)
        assert binding.market_identity == original and binding.runtime == {"saved": "evidence"}
        assert db.get(storage.Watch, watch_id).status == "cancelled"
        assert any(item["kind"] == "strategy" for item in references(db, dataset)["items"])
