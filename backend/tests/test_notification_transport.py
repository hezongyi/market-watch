import json
import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from alerts import api, notify
from alerts.notification_transport import TransportInput, save_transport, read_transport, check_connection, phone_reason
from alerts.storage import Audit, Notification, Outbox, Preference, now_ms


def body(**values):
    return TransportInput(url="https://ntfy.example", topic="test-topic", **values)


def test_secrets_are_preserved_not_returned_or_audited_and_revision_checked(database):
    result = save_transport(body(token="private-fixture-token", enabled=True))
    assert result["token_configured"] and "token" not in result
    assert "private-fixture-token" not in json.dumps(read_transport())
    result = save_transport(body(revision=1, enabled=True))
    with database() as db:
        assert db.get(Preference, "notification_transport").value["token"] == "private-fixture-token"
        assert "private-fixture-token" not in json.dumps([a.details for a in db.scalars(select(Audit))])
        assert phone_reason(db) is None
    with pytest.raises(HTTPException) as error:
        save_transport(body(revision=1))
    assert error.value.status_code == 409
    assert not save_transport(body(revision=2, clear_token=True))["token_configured"]


def test_enabled_transition_keeps_old_history_without_delivery_burst(database, monkeypatch):
    monkeypatch.setattr(notify, "now_ms", lambda: 1794920400000)  # Daytime Shanghai, independent of CI clock.
    monkeypatch.setattr(notify.settings, "delivery_enabled", False)
    with database.begin() as db:
        note = Notification(kind="system", status="pending", payload={"message":"old"})
        db.add(note); db.flush()
        db.add(Outbox(notification_id=note.id, status="pending", next_at=0))
        ident = note.id
    save_transport(body(enabled=True))
    with database() as db:
        assert db.get(Notification, ident).status == "late_suppressed"
        assert db.scalar(select(Outbox)).status == "cancelled"
    # A fresh event after enabling uses the DB config, not process env.
    with database.begin() as db:
        note = Notification(kind="system", status="pending", payload={"message":"new"})
        db.add(note); db.flush()
        db.add(Outbox(notification_id=note.id, status="pending", next_at=0))
    calls = []
    client = httpx.Client(transport=httpx.MockTransport(lambda req: (calls.append(req) or httpx.Response(200, json={"id":"accepted"}))))
    assert notify.deliver_once(client)
    assert calls[0].url.host == "ntfy.example"
    assert json.loads(calls[0].content)["topic"] == "test-topic"
    save_transport(body(revision=1, enabled=False))
    assert phone_reason() == "phone_delivery_disabled"


def test_configuration_fix_releases_authorization_block_and_new_worker_uses_token(database):
    save_transport(body(token="old"))
    queued = api.send_notification_test()
    denied = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401)))
    assert notify.deliver_once(denied)
    assert api.notification_test_result(queued["test_id"])["outbox_status"] == "blocked"
    save_transport(body(revision=1, token="new"))
    def accepted(req):
        assert req.headers["authorization"] == "Bearer new"
        return httpx.Response(200, json={"id":"accepted"})
    assert notify.deliver_once(httpx.Client(transport=httpx.MockTransport(accepted)))
    result = api.notification_test_result(queued["test_id"])
    assert result["status"] == "server_accepted" and result["ack_at"] is None


def test_check_only_reads_health_and_does_not_queue_notifications(database):
    save_transport(body())
    def receive(req):
        assert req.method == "GET" and req.url.path == "/v1/health"
        return httpx.Response(200, json={"healthy":True})
    assert check_connection(httpx.Client(transport=httpx.MockTransport(receive)))["ok"]
    assert not check_connection(httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, text="html"))))["ok"]
    with database() as db:
        assert not db.scalar(select(Notification))


def test_manual_test_bypasses_quiet_hours_and_delivery_off(database):
    save_transport(body(enabled=False))
    with database.begin() as db:
        db.add(Preference(key="notifications", value={"quiet_enabled":True,"quiet_start":"00:00","quiet_end":"23:59"}))
    queued = api.send_notification_test()
    assert notify.deliver_once(httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200,json={"id":"test"}))))
    assert api.notification_test_result(queued["test_id"])["status"] == "server_accepted"


def test_notification_click_enters_app_without_confirming_or_legacy_web_routes(database, monkeypatch):
    from urllib.parse import urlsplit, parse_qs
    monkeypatch.setattr(notify.settings, "public_url", "https://192.168.7.232:18443")
    monkeypatch.setattr(notify.settings, "ntfy_callback_url", "https://quant.kookvv.com:8443/")
    save_transport(body())
    queued = api.send_notification_test()
    sent = []
    assert notify.deliver_once(httpx.Client(transport=httpx.MockTransport(
        lambda req: (sent.append(json.loads(req.content)) or httpx.Response(200, json={"id":"accepted"})))))
    link = urlsplit(sent[0]["click"])
    assert (link.scheme, link.netloc) == ("marketwatch", "notification")
    assert parse_qs(link.query) == {"server":["https://192.168.7.232:18443"], "page":["notifications"]}
    assert api.notification_test_result(queued["test_id"])["ack_at"] is None
    action = sent[0]["actions"][0]
    assert action["action"] == "http" and action["method"] == "POST"
    assert action["label"] == "确认测试" and action["clear"] is True
    assert action["url"] == f"https://quant.kookvv.com:8443/api/notification-tests/{queued['test_id']}/ack"
    assert action["headers"]["Authorization"].startswith("Bearer ")
    assert "Bearer" not in sent[0]["click"]
    # Explicit confirmation still uses the existing scoped HTTP action, separately from opening the app.
    assert sent[0]["actions"][0]["url"].endswith(f"/api/notification-tests/{queued['test_id']}/ack")
    assert parse_qs(urlsplit(notify.notification_link("signal", "event-1")).query)["signal"] == ["event-1"]
    assert parse_qs(urlsplit(notify.notification_link("system", alert=True)).query)["records"] == ["alerts"]
    assert parse_qs(urlsplit(notify.notification_link("system")).query)["records"] == ["system"]


@pytest.mark.parametrize("url", ["file:///tmp", "https://user:pass@ntfy.example", "https://ntfy.example?token=secret"])
def test_bad_transport_urls_rejected(url):
    with pytest.raises(ValidationError):
        TransportInput(url=url)


def test_http_requires_session_and_csrf_and_validation_does_not_echo_token(database):
    from fastapi.testclient import TestClient
    client = TestClient(api.app)
    assert client.get('/api/settings/notification-transport').status_code == 401
    assert client.post('/api/settings/notification-transport/check', json={}).status_code == 401
    from alerts.storage import LoginSession
    with database.begin() as db:
        db.add(LoginSession(token_hash=api.digest("transport-fixture-session"), csrf="transport-fixture-csrf", expires=now_ms() + 60000))
    client.cookies.set("session", "transport-fixture-session")
    assert client.post('/api/settings/notification-transport/check', json={}).status_code == 403
    client.cookies.clear()
    api.app.dependency_overrides[api.authenticated] = lambda: 'fixture' 
    try:
        response = client.post('/api/settings/notification-transport', json={
            'url':'file:///invalid','token':'never-echo-fixture'})
        assert response.status_code == 422
        assert 'never-echo-fixture' not in response.text
        assert client.post('/api/settings/notification-transport', json={
            'url':'https://ntfy.example','topic':'fixture','token':'never-return-fixture'}).status_code == 200
        assert 'never-return-fixture' not in client.get('/api/settings/notification-transport').text
    finally:
        api.app.dependency_overrides.clear()


def test_user_receipt_is_explicit_idempotent_and_stops_test_retry(database):
    save_transport(body())
    queued = api.send_notification_test()
    result = api.confirm_notification_test_received(queued['test_id'])
    assert result['confirmation'] == 'user_reported'
    api.confirm_notification_test_received(queued['test_id'])
    assert api.notification_test_result(queued['test_id'])['status'] == 'acknowledged'
    with database() as db:
        assert db.scalar(select(Outbox)).status == 'cancelled'
        events = db.scalars(select(Audit).where(Audit.kind == 'notification_test_acknowledged')).all()
        assert len(events) == 1 and events[0].details['confirmation'] == 'user_reported'
