from datetime import UTC, datetime

import httpx
from alerts import notify
from alerts.service import acknowledge, create_watch, evaluate_watch
from alerts.storage import AckGrant, DeliveryAttempt, Notification, Outbox, Preference
from sqlalchemy import select
from test_service import seed


def pending(database):
    with database.begin() as db:
        seed(db)
        watch = create_watch(db, "EURUSD", "test", {"kind": "pullback"}, armed_at=28_800_000)
        evaluate_watch(db, watch.id)
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
