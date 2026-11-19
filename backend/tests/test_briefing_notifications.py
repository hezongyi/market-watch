"""Dedicated report delivery; every HTTP request uses an in-memory transport."""

import json

import httpx
import pytest
from alerts import api, notify
from alerts import briefing_service as service
from alerts import briefing_worker as worker
from alerts.storage import AckGrant, BriefingPlan, BriefingReport, Notification, Outbox, Preference
from sqlalchemy import func, select
from test_briefing import NOW, seed


def pending(database, monkeypatch):
    clock = [NOW]
    monkeypatch.setattr(notify, "now_ms", lambda: clock[0])
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "test-only-no-network")
    monkeypatch.setattr(notify.settings, "public_url", "https://fixture.invalid:8443")
    with database.begin() as db:
        seed(db)
        report = service.due(db, at=NOW)
        report.status = "running"
        report.attempt = 1
        ident = report.id
    assert worker.publish(
        {"id": ident, "attempt": 1},
        "ready",
        {"coverage": {"ok": 0, "total": 0}, "sections": []},
        at=NOW,
    )
    with database.begin() as db:
        report = db.get(BriefingReport, ident)
        return clock, report.notification_id


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_accept_once_without_ack_or_pending_alert_count(database, monkeypatch):
    clock, ident = pending(database, monkeypatch)
    seen = []
    count = api.pending_signals()["count"]

    def accept(request):
        body = json.loads(request.content)
        seen.append(body)
        assert body["priority"] == 3 and "actions" not in body
        assert body["click"].startswith("marketwatch://briefing/open?")
        assert "/m/more?briefing=" in body["message"]
        return httpx.Response(200, json={"id": "fixture-accepted"})

    assert notify.deliver_once(client(accept))
    clock[0] += 600000
    assert not notify.deliver_once(client(accept))
    with database() as db:
        note = db.get(Notification, ident)
        assert note.status == "server_accepted" and note.ack_at is None and note.ack_hash is None
        assert db.scalar(select(func.count()).select_from(AckGrant)) == 0
        assert db.scalar(select(Outbox).where(Outbox.notification_id == ident)).status == "accepted"
    assert len(seen) == 1 and api.pending_signals()["count"] == count


@pytest.mark.parametrize("status", [500, 503, None])
def test_bounded_failures_three_attempts(database, monkeypatch, status):
    clock, ident = pending(database, monkeypatch)
    calls = []

    def fail(request):
        calls.append(1)
        if status is None:
            raise httpx.ReadTimeout("fixture", request=request)
        return httpx.Response(status)

    for i, delay in enumerate([30000, 120000, 120000], 1):
        assert notify.deliver_once(client(fail))
        with database() as db:
            row = db.scalar(select(Outbox).where(Outbox.notification_id == ident))
            assert row.attempts == i and row.next_at == clock[0] + delay
            assert row.status == ("cancelled" if i == 3 else "pending")
        clock[0] += delay
    assert not notify.deliver_once(client(fail)) and len(calls) == 3


@pytest.mark.parametrize("status", [401, 403])
def test_auth_error_is_blocked(database, monkeypatch, status):
    clock, ident = pending(database, monkeypatch)
    assert notify.deliver_once(client(lambda _: httpx.Response(status)))
    clock[0] += 600000
    assert not notify.deliver_once(client(lambda _: pytest.fail("blocked sent again")))
    with database() as db:
        assert db.scalar(select(Outbox).where(Outbox.notification_id == ident)).status == "blocked"


@pytest.mark.parametrize(
    "case", ["paused", "disabled", "expired", "quiet", "system-quiet", "missing-topic"]
)
def test_no_delivery_when_ineligible(database, monkeypatch, case):
    clock, ident = pending(database, monkeypatch)
    with database.begin() as db:
        if case == "paused":
            db.get(BriefingPlan, service.PLAN_ID).enabled = False
        elif case in ("quiet", "system-quiet"):
            db.add(
                Preference(
                    key="notifications",
                    value={
                        "quiet_enabled": case == "quiet",
                        "system_quiet_enabled": case == "system-quiet",
                        "quiet_start": "07:00",
                        "quiet_end": "11:00",
                        "timezone": "Asia/Shanghai",
                    },
                )
            )
    if case == "expired":
        clock[0] += 7200000
    if case == "disabled":
        monkeypatch.setattr(notify.settings, "delivery_enabled", False)
    if case == "missing-topic":
        monkeypatch.setattr(notify.settings, "ntfy_topic", "")
    assert not notify.deliver_once(client(lambda _: pytest.fail("ineligible request")))
    if case != "missing-topic":
        with database() as db:
            assert (
                db.scalar(select(Outbox).where(Outbox.notification_id == ident)).status
                == "cancelled"
            )


def test_stale_http_result_cannot_override_new_attempt(database, monkeypatch):
    clock, ident = pending(database, monkeypatch)

    def accept(request):
        with database.begin() as db:
            row = db.scalar(select(Outbox).where(Outbox.notification_id == ident))
            row.attempts = 2
            row.status = "sending"
        return httpx.Response(200, json={"id": "old-attempt"})

    assert notify.deliver_once(client(accept))
    with database() as db:
        row = db.scalar(select(Outbox).where(Outbox.notification_id == ident))
        assert row.attempts == 2 and row.status == "sending"


def test_pause_during_generation_records_without_delivery(database, monkeypatch):
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "test-only-no-network")
    with database.begin() as db:
        seed(db)
    task = worker.claim(at=NOW)
    with database.begin() as db:
        service.save_plan(db, enabled=False, group_ids=["fx"], revision=1, at=NOW)
    assert worker.publish(
        task, "ready", {"coverage": {"ok": 0, "total": 0}, "sections": []}, at=NOW
    )
    with database() as db:
        report = db.get(BriefingReport, task["id"])
        assert report.status == "ready"
        assert (
            db.scalar(select(Outbox).where(Outbox.notification_id == report.notification_id)).status
            == "cancelled"
        )
