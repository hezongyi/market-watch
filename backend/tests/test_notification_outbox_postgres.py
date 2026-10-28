"""Persistent notification types share the PostgreSQL Outbox contract."""
import os
import uuid

import httpx
import pytest
from alerts import notify, storage
from alerts.storage import Notification, Outbox, Preference, bootstrap, now_ms
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker
from test_chart_alert_postgres import postgres_alerts as _postgres_alerts

postgres_alerts = _postgres_alerts
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated PostgreSQL")


def test_test_outbox_delivers_without_api_data_owners_or_auto_delivery(
        postgres_alerts, monkeypatch):
    bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    monkeypatch.setattr(notify.settings, "delivery_enabled", False)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "stage3b-test-only")
    assert notify.settings.ntfy_topic == "stage3b-test-only"
    ident = uuid.uuid4().hex
    with factory.begin() as db:
        note = Notification(kind="test", signal_id=None, status="pending",
                            payload={"test_id": ident, "title": "test", "message": "queued"})
        db.add(note)
        db.flush()
        db.add(Outbox(notification_id=note.id, status="pending", attempts=0,
                      next_at=now_ms(), lease_until=None, error=None, provider_id=None))
        db.add(Preference(key="test_notification:" + ident,
                          value={"notification_id": note.id, "ack_at": None}))
        note_id = note.id

    with factory() as db:
        assert db.scalar(select(Outbox).where(Outbox.notification_id == note_id)).next_at <= now_ms()
        assert db.get(Notification, note_id).kind == "test"

    sent = []
    client = httpx.Client(transport=httpx.MockTransport(
        lambda request: (sent.append(request), httpx.Response(200, json={"id": "accepted"}))[1]
    ))
    assert notify.deliver_once(client)
    assert len(sent) == 1
    with factory() as db:
        note = db.get(Notification, note_id)
        task = db.scalar(select(Outbox).where(Outbox.notification_id == note_id))
        assert note.status == "server_accepted"
        assert note.signal_id is None and note.ack_hash
        assert task.status == "accepted" and task.provider_id == "accepted"
