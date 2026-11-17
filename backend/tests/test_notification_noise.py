"""User-visible runtime push policy; clocks and transport are deterministic."""
import httpx
from sqlalchemy import select


def runtime_scope(monkeypatch, clock):
    from alerts import runtime_health, storage
    monkeypatch.setattr(runtime_health, "expected_roles", lambda: ("data:provider_live_fxcm",))
    monkeypatch.setattr(storage, "now_ms", lambda: clock[0])


def test_fifteen_second_runtime_blip_never_pushes(database, monkeypatch):
    from alerts import notification_runtime, notify, runtime_health
    from alerts.storage import Preference
    clock = [1794920400000]  # 21:00 Shanghai; transport must still suppress a blip.
    runtime_scope(monkeypatch, clock)
    monkeypatch.setattr(notify, "now_ms", lambda: clock[0])
    monkeypatch.setattr(notify.settings, "ntfy_topic", "fixture-never-network")
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    requests = []
    client = httpx.Client(transport=httpx.MockTransport(
        lambda req: (requests.append(req), httpx.Response(200, json={"id": "fixture"}))[1]))
    notification_runtime.inspect_health()
    notify.deliver_once(client)
    clock[0] += 15_000
    with database.begin() as db:
        db.add(Preference(key=runtime_health.key("provider_live_fxcm"), value={
            "checked_at": clock[0], "stale_after_ms": 60_000, "error_type": None,
        }))
    notification_runtime.inspect_health()
    notify.deliver_once(client)
    assert requests == [], "A self-recovered 15-second blip must not ring the phone"


def test_system_push_does_not_inherit_urgent_price_alert_priority(database, monkeypatch):
    from alerts import notification_runtime, notify
    monkeypatch.setattr(notify.settings, "ntfy_topic", "fixture-never-network")
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify, "now_ms", lambda: 1794920400000)
    with database.begin() as db:
        notification_runtime._queue_system_notice(db, title="后台服务异常", message="fixture",
            incident_id="system:fixture", at=1794920400000)
    request = notify.claim()
    assert request is not None
    assert request[2]["priority"] <= 3, "Infrastructure health must not inherit priority 5"


def test_each_system_notification_links_to_its_own_record(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Outbox
    monkeypatch.setattr(notify.settings, "ntfy_topic", "fixture-never-network")
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify, "now_ms", lambda: 1794920400000)
    links = []
    for index in range(2):
        with database.begin() as db:
            notification_runtime._queue_system_notice(db, title="后台服务异常", message=str(index),
                incident_id=f"system:{index}", at=1794920400000)
        request = notify.claim()
        assert request is not None
        links.append(request[2]["click"])
        with database.begin() as db:
            db.get(Outbox, request[0]).status = "accepted"
    assert links[0] != links[1], "Different notifications must open their corresponding records"


def setup_runtime(monkeypatch):
    from alerts import notify, runtime_health
    clock = [1794920400000]
    runtime_scope(monkeypatch, clock)
    monkeypatch.setattr(runtime_health, "now_ms", lambda: clock[0])
    monkeypatch.setattr(notify, "now_ms", lambda: clock[0])
    monkeypatch.setattr(notify.settings, "ntfy_topic", "fixture-never-network")
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    return clock


def recover(database, clock):
    from alerts import runtime_health
    from alerts.storage import Preference
    with database.begin() as db:
        row = db.get(Preference, runtime_health.key("provider_live_fxcm"))
        value = {"checked_at": clock[0], "stale_after_ms": 60_000, "error_type": None}
        if row:
            row.value = value
        else:
            db.add(Preference(key=runtime_health.key("provider_live_fxcm"), value=value))


def test_persistent_fault_waits_three_minutes_then_pushes_once(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Notification
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    assert notify.claim() is None
    clock[0] += 179_999
    assert notify.claim() is None
    clock[0] += 1
    requests = []
    client = httpx.Client(transport=httpx.MockTransport(
        lambda req: (requests.append(req), httpx.Response(200, json={"id": "fixture"}))[1]))
    assert notify.deliver_once(client)
    for _ in range(3):
        clock[0] += 900_000
        notification_runtime.inspect_health()
        notify.deliver_once(client)
    assert len(requests) == 1
    with database.begin() as db:
        assert len(list(db.scalars(select(Notification)))) == 1


def test_recovered_before_delivery_never_replays_old_fault_or_recovery(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Notification, Outbox
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    clock[0] += 20_000
    recover(database, clock)
    notification_runtime.inspect_health()
    clock[0] += 300_000
    for _ in range(4):
        assert notify.claim() is None
    with database.begin() as db:
        notes = list(db.scalars(select(Notification)))
        assert len(notes) == 2 and all(n.ack_at is None for n in notes)
        assert all(row.status == "cancelled" for row in db.scalars(select(Outbox)))


def test_new_failure_episode_restarts_the_full_delay(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Preference
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    first = clock[0]
    clock[0] += 15_000
    recover(database, clock)
    notification_runtime.inspect_health()
    clock[0] += 90_000  # The healthy record now becomes stale: a separate episode.
    notification_runtime.inspect_health()
    with database.begin() as db:
        incident = db.get(Preference, "runtime_incident:data:provider_live_fxcm")
        assert incident.value["opened_at"] == clock[0] != first
    for _ in range(3):
        assert notify.claim() is None
    clock[0] += 180_000
    assert notify.claim() is not None


def test_night_fault_is_deferred_but_recovered_fault_is_not_sent_in_morning(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Outbox, Preference
    clock = setup_runtime(monkeypatch)
    clock[0] += 3 * 3600_000  # midnight Shanghai
    notification_runtime.inspect_health()
    clock[0] += 180_000
    assert notify.claim() is None
    with database.begin() as db:
        row = db.scalar(select(Outbox))
        morning = row.next_at
        assert morning > clock[0]
        assert db.get(Preference, "notifications") is None  # Defaults protect existing installs too.
    recover(database, clock)
    notification_runtime.inspect_health()
    clock[0] = morning
    for _ in range(3):
        assert notify.claim() is None


def test_night_fault_still_active_in_morning_can_push(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Outbox
    clock = setup_runtime(monkeypatch)
    clock[0] += 3 * 3600_000
    notification_runtime.inspect_health()
    clock[0] += 180_000
    assert notify.claim() is None
    with database.begin() as db:
        clock[0] = db.scalar(select(Outbox)).next_at
    assert notify.claim() is not None


def test_send_rechecks_heartbeat_even_before_next_health_inspection(database, monkeypatch):
    from alerts import notification_runtime, notify
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    clock[0] += 180_000
    recover(database, clock)
    assert notify.claim() is None


def test_system_records_exact_source_and_delivery_without_popup_or_ack(database, monkeypatch):
    from alerts import notification_runtime, notify, notification_center as center
    from alerts.storage import Notification, NoticeEvent
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    with database.begin() as db:
        ident = db.scalar(select(Notification)).id
        result = center.system_notification(db, ident)
        assert result["notification_id"] == ident
        assert result["title"] == "后台服务异常" and result["occurred_at"] == clock[0]
        assert not result["notify_web"] and not result["attention"]
        assert result["ack_at"] is None and result["notification_status"] == "pending"
    clock[0] += 180_000
    notify.deliver_once(httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"id": "fixture-receipt"}))))
    with database.begin() as db:
        center.project(db)
        result = center.system_notification(db, ident)
        assert result["notification_status"] == "server_accepted"
        timeline = center.timeline(db, center.SUBJECT, result["id"])
        assert timeline["observations"][0]["details"]["status"] == "accepted"
        assert db.get(Notification, ident).ack_at is None
        center.project(db)
        assert len(list(db.scalars(select(NoticeEvent)))) == 1
    recover(database, clock)
    notification_runtime.inspect_health()
    with database.begin() as db:
        result = center.system_notification(db, ident)
        assert result["resolved_at"] == clock[0]
        assert result["incident"]["closed_at"] == clock[0]
        assert result["ack_at"] is None


def test_backfill_imports_old_system_records_without_network(database, monkeypatch):
    from alerts import notification_center as center, notification_runtime
    from alerts.storage import NoticeEvent
    setup_runtime(monkeypatch)
    with database.begin() as db:
        note = notification_runtime._queue_system_notice(db, title="历史运行记录", message="fixture",
                                                       incident_id="legacy:fixture")
        ident = note.id
    with database.begin() as db:
        assert center.backfill(db) == 1
        assert db.get(NoticeEvent, "n:" + ident).body["title"] == "历史运行记录"
        assert center.backfill(db) == 0


def test_legacy_queued_runtime_summary_is_not_replayed(database, monkeypatch):
    from alerts import notification_runtime, notify
    clock = setup_runtime(monkeypatch)
    with database.begin() as db:
        notification_runtime._queue_system_notice(db, title="旧故障", message="fixture",
            incident_id="runtime-faults:legacy", at=clock[0] - 3600_000)
    assert notify.claim() is None


def test_recovery_during_send_preserves_resolution_and_receipt(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Notification, Outbox, DeliveryAttempt
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    clock[0] += 180_000
    with database.begin() as db:
        ident = db.scalar(select(Notification)).id

    def late_response(request):
        recover(database, clock)
        notification_runtime.inspect_health()
        return httpx.Response(200, json={"id": "late-receipt"})

    notify.deliver_once(httpx.Client(transport=httpx.MockTransport(late_response)))
    with database.begin() as db:
        note = db.get(Notification, ident)
        assert note.status == "resolved" and note.ack_at is None
        assert note.payload["resolved_at"] == clock[0]
        assert db.scalar(select(Outbox).where(Outbox.notification_id == ident)).status == "cancelled"
        assert db.scalar(select(DeliveryAttempt).where(DeliveryAttempt.notification_id == ident)).status == "accepted"


def test_system_quiet_can_be_disabled_without_changing_price_priority(database, monkeypatch):
    from alerts import notification_runtime, notify
    from alerts.storage import Preference
    clock = setup_runtime(monkeypatch)
    clock[0] += 3 * 3600_000
    with database.begin() as db:
        db.add(Preference(key="notifications", value={"system_quiet_enabled": False, "priority": 5}))
    notification_runtime.inspect_health()
    clock[0] += 180_000
    task = notify.claim()
    assert task and task[2]["priority"] == 3
    with database.begin() as db:
        assert db.get(Preference, "notifications").value["priority"] == 5


def test_recovery_for_an_unpushed_fault_is_always_log_only(database, monkeypatch):
    from alerts import notification_runtime, notify
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    clock[0] += 15_000
    recover(database, clock)
    notification_runtime.inspect_health()
    assert notify.claim() is None
    assert notify.claim() is None


def test_recovery_push_after_accepted_fault_is_low_priority(database, monkeypatch):
    from alerts import notification_runtime, notify
    clock = setup_runtime(monkeypatch)
    notification_runtime.inspect_health()
    clock[0] += 180_000
    notify.deliver_once(httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"id": "fixture"}))))
    recover(database, clock)
    notification_runtime.inspect_health()
    task = notify.claim()
    assert task and task[2]["priority"] == 2


def test_system_detail_unknown_id_does_not_return_another_message(database, monkeypatch):
    import pytest
    from fastapi import HTTPException
    from alerts import notification_center as center
    setup_runtime(monkeypatch)
    with database.begin() as db:
        with pytest.raises(HTTPException) as error:
            center.system_notification(db, "nonexistent")
        assert error.value.status_code == 404


def test_price_alert_keeps_urgent_policy_at_night(database, monkeypatch):
    from alerts import notify
    from alerts.storage import Outbox
    from test_notify import pending
    clock = setup_runtime(monkeypatch)
    clock[0] += 3 * 3600_000
    pending(database)
    with database.begin() as db:
        db.scalar(select(Outbox)).next_at = 0
    task = notify.claim()
    assert task and task[2]["priority"] == 5
