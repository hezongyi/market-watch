from datetime import UTC, datetime

import httpx
from alerts import notify
from alerts.chart_alert_service import consume, create
from alerts.service import acknowledge
from alerts.storage import AckGrant, DeliveryAttempt, Notification, Outbox, Preference
from sqlalchemy import select
from test_chart_alert_service import config, sample


def pending(database):
    with database.begin() as db:
        rule = create(db, "delivery-fixture", config(notify_ntfy=True), at=0)
        consume(db, rule.id, sample(0, 9), detected_at=0)
        consume(db, rule.id, sample(1, 11), detected_at=300001)
        db.flush()
        return db.scalar(select(Notification)).id


def configure(monkeypatch):
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "test-only-never-network")


def test_disabled_delivery_never_calls_transport(database, monkeypatch):
    pending(database)
    monkeypatch.setattr(notify.settings, "delivery_enabled", False)

    def forbidden(_):
        raise AssertionError("Unexpected HTTP")

    assert not notify.deliver_once(httpx.Client(transport=httpx.MockTransport(forbidden)))


def test_receipt_unknown_and_ack_idempotent(database, monkeypatch):
    note_id = pending(database)
    configure(monkeypatch)
    requests = []

    def ok(req):
        requests.append(req)
        return httpx.Response(200, json={"id": "server-message"})

    assert notify.deliver_once(httpx.Client(transport=httpx.MockTransport(ok)))
    with database.begin() as db:
        note = db.get(Notification, note_id)
        assert note.status == "server_accepted" and note.ack_at is None
        assert db.scalar(select(AckGrant)).notification_id == note_id
        assert db.scalar(select(DeliveryAttempt)).status == "accepted"
        acknowledge(db, note_id)
        acknowledge(db, note_id)
    assert not notify.deliver_once(httpx.Client(transport=httpx.MockTransport(ok)))
    assert len(requests) == 1


def test_timeout_and_retry_keep_old_ack_grant(database, monkeypatch):
    note_id = pending(database)
    configure(monkeypatch)

    def timeout(req):
        raise httpx.ReadTimeout("response lost", request=req)

    notify.deliver_once(httpx.Client(transport=httpx.MockTransport(timeout)))
    with database.begin() as db:
        row = db.scalar(select(Outbox))
        assert row.status == "pending"
        row.next_at = 0
        old = db.scalar(select(AckGrant)).token_hash
    notify.deliver_once(
        httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"id": "new"}))
        )
    )
    with database.begin() as db:
        assert db.get(AckGrant, old).notification_id == note_id
        assert len(db.scalars(select(AckGrant)).all()) == 2


def test_ack_racing_with_publish_wins(database, monkeypatch):
    note_id = pending(database)
    configure(monkeypatch)

    def ok(req):
        with database.begin() as db:
            acknowledge(db, note_id)
        return httpx.Response(200, json={"id": "late"})

    notify.deliver_once(httpx.Client(transport=httpx.MockTransport(ok)))
    with database.begin() as db:
        assert db.get(Notification, note_id).status == "acknowledged"
        assert db.scalar(select(Outbox)).status == "cancelled"


def test_quiet_cross_midnight_and_boundary():
    config = {**notify.DEFAULTS, "quiet_enabled": True}
    assert notify.quiet_until(datetime(2026, 9, 28, 16, tzinfo=UTC), config).hour == 7
    assert notify.quiet_until(datetime(2026, 9, 28, 23, tzinfo=UTC), config) is None
    assert notify.quiet_until(datetime(2026, 9, 28, 14, tzinfo=UTC), config) is None


def test_quiet_defers_without_http(database, monkeypatch):
    note_id = pending(database)
    configure(monkeypatch)
    monkeypatch.setattr(notify, "now_ms", lambda: 1790611200000)  # 2026-09-28 16 UTC
    with database.begin() as db:
        db.scalar(select(Outbox)).next_at = 0
        db.add(Preference(key="notifications", value={**notify.DEFAULTS, "quiet_enabled": True}))
    assert notify.claim() is None
    with database.begin() as db:
        assert db.get(Notification, note_id).status == "quiet"


def test_system_notice_obeys_quiet_hours(database, monkeypatch):
    from alerts.notification_runtime import _queue_system_notice

    with database.begin() as db:
        _queue_system_notice(db, title="runtime fault", message="database unavailable",
                             incident_id="runtime-faults:test")
        note_id = db.scalar(select(Notification).order_by(Notification.created_at.desc())).id
        db.scalar(select(Outbox)).next_at = 0
        db.add(Preference(key="notifications", value={
            **notify.DEFAULTS, "quiet_enabled": True,
        }))
    configure(monkeypatch)
    monkeypatch.setattr(notify, "now_ms", lambda: 1790611200000)  # 2026-09-28 16 UTC
    assert notify.claim() is None
    with database.begin() as db:
        assert db.get(Notification, note_id).status == "quiet"


def test_late_delivery_cannot_overwrite_new_owner(database, monkeypatch):
    note_id = pending(database)
    configure(monkeypatch)

    def late_response(request):
        with database.begin() as db:
            row = db.scalar(select(Outbox))
            row.attempts += 1
            row.status = "accepted"
            row.provider_id = "new-owner-message"
            db.get(Notification, note_id).status = "server_accepted"
        raise httpx.ReadTimeout("old request finished late", request=request)

    notify.deliver_once(httpx.Client(transport=httpx.MockTransport(late_response)))
    with database.begin() as db:
        row = db.scalar(select(Outbox))
        assert row.status == "accepted" and row.provider_id == "new-owner-message"
        assert db.get(Notification, note_id).status == "server_accepted"
        assert db.scalar(select(DeliveryAttempt)).status == "failed_or_unknown"


def test_manual_retry_only_blocked_and_never_acknowledged(database):
    import pytest
    from alerts.api import retry_notification
    from fastapi import HTTPException

    ident = pending(database)
    with database.begin() as db:
        db.scalar(select(Outbox)).status = "blocked"
    assert retry_notification(ident) == {"status": "pending"}
    with pytest.raises(HTTPException) as error:
        retry_notification(ident)
    assert error.value.status_code == 409
    with database.begin() as db:
        db.scalar(select(Outbox)).status = "blocked"
        acknowledge(db, ident)
    with pytest.raises(HTTPException) as error:
        retry_notification(ident)
    assert error.value.status_code == 409


def test_chart_alert_retry_and_phone_action_round_trip(database, monkeypatch):
    """Actual ChartAlert/outbox/API path; only the external ntfy HTTP service is simulated."""
    import json
    from urllib.parse import urlsplit

    from alerts import api as api_module
    from alerts.storage import ChartAlert, SignalRow
    from fastapi.testclient import TestClient

    note_id = pending(database)
    configure(monkeypatch)
    bodies = []

    def transport(request):
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            # ntfy may have accepted this message before its response was lost.
            raise httpx.ReadTimeout("accepted but response lost", request=request)
        return httpx.Response(200, json={"id": "retried-message"})

    client = httpx.Client(transport=httpx.MockTransport(transport))
    assert notify.deliver_once(client)
    with database.begin() as db:
        task = db.scalar(select(Outbox))
        assert task.status == "pending"
        task.next_at = 0
        # Simulate a worker dying after claiming a retry; expiry must permit takeover.
        task.status = "sending"
        task.lease_until = 0
    assert notify.deliver_once(client)
    action = bodies[0]["actions"][0]
    assert action["method"] == "POST" and action["clear"] is True
    path = urlsplit(action["url"]).path
    with TestClient(api_module.app) as website:
        assert website.post(path).status_code == 403
        assert website.post(path, headers={"Authorization": "Bearer invalid"}).status_code == 403
        assert (
            website.post(
                path.replace(note_id, "different-notification"), headers=action["headers"]
            ).status_code
            == 403
        )
        assert website.post(path, headers=action["headers"]).json()["status"] == "acknowledged"
        assert website.post(path, headers=action["headers"]).json()["status"] == "acknowledged"
        second = bodies[1]["actions"][0]
        assert (
            website.post(urlsplit(second["url"]).path, headers=second["headers"]).status_code == 200
        )
    with database.begin() as db:
        assert db.get(Notification, note_id).ack_at is not None
        assert db.scalar(select(Outbox)).status == "cancelled"
        assert len(db.scalars(select(SignalRow)).all()) == 1
        rule = db.scalar(select(ChartAlert))
        assert rule.count == 1
        assert consume(db, rule.id, sample(1, 11), detected_at=300001) is None
        assert len(db.scalars(select(DeliveryAttempt)).all()) == 2
    assert not notify.deliver_once(client)
    assert len(bodies) == 2
