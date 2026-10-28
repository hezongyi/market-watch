import httpx
import pytest
from alerts import api, notify
from fastapi import HTTPException


def test_explicit_test_works_with_auto_delivery_off_and_rate_limits(database, monkeypatch):
    monkeypatch.setattr(api.settings, "ntfy_topic", "unit-test-only")
    monkeypatch.setattr(api.settings, "delivery_enabled", False)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "unit-test-only")
    monkeypatch.setattr(notify.settings, "delivery_enabled", False)
    calls = []

    def receive(request):
        calls.append(request)
        return httpx.Response(200, json={"id": "test"})

    client = httpx.Client(transport=httpx.MockTransport(receive))
    queued = api.send_notification_test()
    assert queued["device_delivery"] == "unknown"
    assert queued["status"] == "queued"
    assert notify.deliver_once(client)
    with pytest.raises(HTTPException) as caught:
        api.send_notification_test()
    assert caught.value.status_code == 429
    assert len(calls) == 1


def test_missing_topic_cannot_send(database, monkeypatch):
    monkeypatch.setattr(api.settings, "ntfy_topic", "")
    with pytest.raises(HTTPException) as caught:
        api.send_notification_test()
    assert caught.value.status_code == 409


def test_timeout_records_unknown_not_accepted(database, monkeypatch):
    from alerts.storage import Audit
    from sqlalchemy import select

    monkeypatch.setattr(api.settings, "ntfy_topic", "unit-test-only")
    monkeypatch.setattr(notify.settings, "ntfy_topic", "unit-test-only")

    def timeout(request):
        raise httpx.ReadTimeout("response lost", request=request)

    client = httpx.Client(transport=httpx.MockTransport(timeout))
    api.send_notification_test()
    assert notify.deliver_once(client)
    with database.begin() as db:
        kinds = db.scalars(select(Audit.kind)).all()
        assert "notification_test_failed_or_unknown" in kinds
        assert "notification_test_accepted" not in kinds
    assert api.health()["last_notification_test"]["status"] == "notification_test_failed_or_unknown"


def test_test_confirmation_is_scoped_and_idempotent(database, monkeypatch):
    import json

    from alerts.storage import Audit
    from sqlalchemy import select
    from starlette.requests import Request

    monkeypatch.setattr(api.settings, "ntfy_topic", "unit-test-only")
    monkeypatch.setattr(notify.settings, "ntfy_topic", "unit-test-only")
    sent = []

    def receive(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(receive))
    api.send_notification_test()
    assert notify.deliver_once(client)
    action = sent[0]["actions"][0]
    ident = action["url"].split("/")[-2]

    def request(token):
        return Request({"type": "http", "headers": [(b"authorization", token.encode())]})

    with pytest.raises(HTTPException):
        api.acknowledge_test(ident, request("Bearer wrong"))
    valid = request(action["headers"]["Authorization"])
    assert api.acknowledge_test(ident, valid)["status"] == "acknowledged"
    api.acknowledge_test(ident, valid)
    with database.begin() as db:
        assert (
            len(
                db.scalars(
                    select(Audit).where(Audit.kind == "notification_test_acknowledged")
                ).all()
            )
            == 1
        )
    assert api.health()["last_notification_test"]["status"] == "notification_test_acknowledged"


def test_late_send_result_does_not_hide_confirmation(database):
    from alerts.storage import Audit, Preference, now_ms

    with database.begin() as db:
        db.add(Audit(kind="notification_test_requested", details={"test_id": "one"}))
        db.flush()
        db.add(Preference(key="test_notification:one", value={"ack_at": now_ms()}))
        db.add(Audit(kind="notification_test_acknowledged", details={"test_id": "one"}))
        db.flush()
        db.add(Audit(kind="notification_test_accepted", details={"test_id": "one"}))
    assert api.health()["last_notification_test"]["status"] == "notification_test_acknowledged"
    with database.begin() as db:
        db.add(Audit(kind="notification_test_requested", details={"test_id": "two"}))
        db.flush()
        db.add(Audit(kind="notification_test_acknowledged", details={"test_id": "one"}))
    assert api.health()["last_notification_test"]["status"] == "notification_test_requested"
