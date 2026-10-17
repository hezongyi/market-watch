from decimal import Decimal

import pytest
from alerts import api as api_module
from alerts import notification_center as center
from alerts.storage import (
    Audit,
    Notification,
    NotificationChange,
    NotificationEvent,
    NotificationObservation,
    Outbox,
    SignalRow,
    now_ms,
)
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select


def login(client, monkeypatch):
    monkeypatch.setattr(api_module.settings, "admin_password_hash",
                        PasswordHasher().hash("alerts-test-only"))
    monkeypatch.setattr(api_module.settings, "cookie_secure", False)
    logged = client.post("/api/login", json={"password": "alerts-test-only"})
    assert logged.status_code == 200
    client.headers["x-csrf-token"] = logged.json()["csrf"]


def add_signal(db, index=1, *, alert=True, notify_web=True, notify_ntfy=True):
    evidence = {}
    if alert:
        evidence = {
            "chart_alert": True, "alert_id": f"alert-{index}", "rule_version": 1,
            "config": {"timeframe": "M5", "notify_web": notify_web, "notify_ntfy": notify_ntfy},
            "market_identity": {"symbol": "EURUSD", "source": "dukascopy"},
            "run": 3, "ordinal": 1, "detected_at": now_ms(),
        }
    signal = SignalRow(
        instrument_id="EURUSD", occurred_at=now_ms() - index * 1000,
        direction="up", price=Decimal("1.10000"), threshold=Decimal("1.09000"),
        reason=f"规则 {index}", evidence=evidence)
    db.add(signal)
    db.flush()
    note = Notification(signal_id=signal.id)
    db.add(note)
    db.flush()
    db.add(Outbox(notification_id=note.id))
    db.add(Audit(kind="chart_alert_signal" if alert else "signal",
                 details={"signal_id": signal.id, "alert_id": f"alert-{index}"}))
    db.flush()
    return signal, note


def test_projection_is_idempotent_and_does_not_duplicate_counts(database):
    with database.begin() as db:
        signal, note = add_signal(db, 1)
    assert center.project_pending(50) == 1
    assert center.project_pending(50) == 0
    with database.begin() as db:
        events = list(db.scalars(select(NotificationEvent)))
        assert len(events) == 1
        event = events[0]
        assert event.id == f"srv:{signal.id}"
        assert event.notification_id == note.id
        incident = event.incident_id
        assert db.scalar(select(NotificationChange.seq).where(
            NotificationChange.event_id == event.id)) is not None
    # A crashed re-run (claim removed) must not create a second occurrence.
    with database.begin() as db:
        claim = db.scalar(select(center.NotificationSourceClaim))
        if claim:
            db.delete(claim)
    assert center.project_pending(50) == 1
    with database.begin() as db:
        assert len(list(db.scalars(select(NotificationEvent)))) == 1
        assert db.get(center.NotificationIncident, incident).count == 1


def test_new_audit_is_picked_up_without_a_watermark(database):
    with database.begin() as db:
        add_signal(db, 1)
    assert center.project_pending(50) == 1
    with database.begin() as db:
        add_signal(db, 2)
    assert center.project_pending(50) == 1
    with database.begin() as db:
        firsts = [row.first_seq for row in db.scalars(select(NotificationEvent))]
    assert len(firsts) == 2 and len(set(firsts)) == 2


def test_pagination_over_five_hundred_and_filters(database):
    with database.begin() as db:
        for index in range(130):
            add_signal(db, index, alert=index % 2 == 0)
    center.project_pending(1000)
    with database.begin() as db:
        page = center.list_events(db, limit=100)
    assert len(page["items"]) == 100 and page["next_before"]
    seen = {row["id"] for row in page["items"]}
    with database.begin() as db:
        second = center.list_events(db, limit=100, before=page["next_before"])
    assert not ({row["id"] for row in second["items"]} & seen)
    with database.begin() as db:
        alerts = center.list_events(db, limit=100, kinds=["alert"], instrument="EURUSD")
    assert alerts["items"] and all(row["kind"] == "alert" for row in alerts["items"])
    with database.begin() as db:
        none = center.list_events(db, limit=10, query="不存在的关键词")
    assert none["items"] == []


def test_browser_event_is_idempotent_and_rejects_conflicting_payload(database):
    payload = {"id": "web:11111111-1111-4111-8111-111111111111", "kind": "failure",
               "severity": "warning", "title": "图表加载失败",
               "summary": "历史容量不足", "occurred_at": now_ms(),
               "context": {"instrument": "EURUSD"}, "profile_id": "p1"}
    first, created = center.record_browser_event(payload)
    assert created is True
    again, created = center.record_browser_event(payload)
    assert created is False and again["id"] == first["id"]
    with pytest.raises(center.NotificationConflict):
        center.record_browser_event({**payload, "title": "不同的负载"})


def test_observation_read_state_and_phone_stop(database, monkeypatch):
    with database.begin() as db:
        signal, note = add_signal(db, 1)
    center.project_pending(50)
    with database.begin() as db:
        event = db.scalar(select(NotificationEvent))
        event_id = event.id
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        page = client.get("/api/notification-center/events").json()
        assert page["unread"] == 1 and page["items"][0]["read"] is False
        viewed = client.post("/api/notification-center/observations",
                             json={"event_id": event_id, "kind": "viewed", "profile_id": "p1"})
        assert viewed.status_code == 200 and viewed.json()["created"] is True
        duplicate = client.post("/api/notification-center/observations",
                                json={"event_id": event_id, "kind": "viewed", "profile_id": "p1"})
        assert duplicate.json()["created"] is False
        page = client.get("/api/notification-center/events").json()
        assert page["unread"] == 0 and page["items"][0]["read"] is True
        detail = client.get(f"/api/notification-center/events/{event_id}").json()
        assert [row["kind"] for row in detail["observations"]] == ["viewed"]
        assert detail["observations"][0]["server_at_iso"].endswith("+00:00")
        stopped = client.post("/api/notification-center/observations",
                              json={"event_id": event_id, "kind": "phone_stop"})
        assert stopped.status_code == 200
    with database.begin() as db:
        assert db.get(Notification, note.id).ack_at is not None
        assert db.scalar(select(Outbox).where(Outbox.notification_id == note.id)).status == "cancelled"


def test_phone_stop_keeps_legacy_ack_semantics(database, monkeypatch):
    with database.begin() as db:
        signal, note = add_signal(db, 1)
    center.project_pending(50)
    with database.begin() as db:
        event_id = db.scalar(select(NotificationEvent.id))
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        old = client.post(f"/api/notifications/{note.id}/ack")
        assert old.status_code == 200
        assert client.get("/api/notification-center/events").json()["unread"] == 1
    with database.begin() as db:
        assert db.get(Notification, note.id).ack_at is not None


def test_changes_cursor_and_epoch_reset(database):
    with database.begin() as db:
        add_signal(db, 1)
    center.project_pending(50)
    with database.begin() as db:
        window = center.change_window(db)
        batch = center.changes_since(db, 0)
        assert batch["reset"] is False and batch["items"]
        reset = center.changes_since(db, 0, epoch="stale-epoch")
        assert reset["reset"] is True and reset["reason"] == "epoch"
        # Simulate retention: the log is gone but the sequence already advanced.
        db.query(NotificationChange).delete()
        db.flush()
        expired = center.changes_since(db, 0)
        assert expired["reset"] is True and expired["reason"] == "expired"
        fresh = center.changes_since(db, window["seq"])
        assert fresh["reset"] is False and fresh["items"] == []


def test_delivery_and_receipt_update_the_same_event(database):
    with database.begin() as db:
        signal, note = add_signal(db, 1)
    center.project_pending(50)
    with database.begin() as db:
        db.add(Audit(kind="notification_delivery", details={
            "kind": "delivery", "notification_id": note.id, "attempt_id": 7,
            "status": "accepted", "at": now_ms(), "provider_id": "p-1"}))
        db.add(Audit(kind="notification_receipt", details={
            "kind": "receipt", "notification_id": note.id, "device_id": "d-1",
            "received_at": now_ms()}))
    center.project_pending(50)
    with database.begin() as db:
        event = db.scalar(select(NotificationEvent))
        channels = event.context["channels"]
        assert {row["channel"] for row in channels} == {"ntfy", "device"}
        assert event.version >= 3
    center.project_pending(50)  # re-projection must not duplicate channel facts
    with database.begin() as db:
        assert len(db.scalar(select(NotificationEvent)).context["channels"]) == 2


def test_retention_writes_tombstone_then_resets_old_cursors(database, monkeypatch):
    with database.begin() as db:
        add_signal(db, 1, alert=False)
    center.project_pending(50)
    monkeypatch.setattr(center, "RETENTION_EVENT_MS", 0)
    with database.begin() as db:
        old = db.scalar(select(NotificationEvent))
        old.occurred_at = now_ms() - 10_000
        db.flush()
    center.prune()
    with database.begin() as db:
        event = db.scalar(select(NotificationEvent))
        assert event.deleted_at is not None
        deletions = list(db.scalars(select(NotificationChange).where(
            NotificationChange.kind == "deleted")))
        assert deletions
    with database.begin() as db:
        page = center.list_events(db)
        assert page["items"] == []


def test_late_committed_lower_audit_id_is_still_projectable(database):
    """A source transaction that commits late must not be skipped by max(id)."""
    with database.begin() as db:
        signal, note = add_signal(db, 1)
        first = db.scalar(select(Audit.id).order_by(Audit.id))
    center.project_pending(10)
    with database.begin() as db:
        late = Audit(id=1, kind="chart_alert_signal",
                     details={"signal_id": signal.id})
        # Move the first audit out of the way so the new source owns a lower id.
        existing = db.get(Audit, first)
        existing.id = 99
        db.add(late)
        db.flush()
    assert center.project_pending(10) == 1
    with database.begin() as db:
        assert len(list(db.scalars(select(NotificationEvent)))) == 1
        claims = list(db.scalars(select(center.NotificationSourceClaim.source_id)))
    assert set(claims) == {"1", "99"}
