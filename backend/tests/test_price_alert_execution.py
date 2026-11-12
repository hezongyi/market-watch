"""Execution incidents, independent patrol, and actual system delivery contracts."""

import pytest
from alerts import chart_alert_execution as execution
from alerts.chart_alert_application import execution_dict
from alerts.chart_alert_service import create, current_version, lifecycle
from alerts.chart_alert_worker import evaluate
from alerts.config import settings
from alerts.price_alert_reasons import NotificationConfigurationError
from alerts.storage import Audit, ChartAlert, Notification, Outbox
from sqlalchemy import func, select
from test_composite_alerts import armed, config, live
from test_price_alert_settlement import publish


def system_notes(db):
    return list(db.scalars(select(Notification).where(Notification.kind == "system").order_by(Notification.created_at)))


def test_transient_fault_is_persistent_but_phone_waits_sixty_seconds(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch, mode="intrabar", notify_ntfy=True)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    live(database, revision, stamp + 100, seam + 600000, connected=False)
    with database.begin() as db:
        evaluate(db, ident, now=stamp + 100)
        alert = db.get(ChartAlert, ident)
        incident = alert.runtime["incident"]["id"]
        assert alert.status == "active" and alert.health == "stale"
        assert alert.health_reason != alert.runtime["reason_code"]
        assert len(system_notes(db)) == 0
        assert db.scalar(select(Audit).where(Audit.kind == "notice_source", Audit.details["source_id"].as_string() == ident))
        execution.patrol(db, now=stamp + 60099)
        assert len(system_notes(db)) == 0
        execution.patrol(db, now=stamp + 60100)
        execution.patrol(db, now=stamp + 60101)
        notes = system_notes(db)
        assert len(notes) == 1 and notes[0].payload["incident_id"] == incident + ":failure"
        assert alert.runtime["execution_notification"]["status"] == "pending"
        assert alert.runtime["execution_notification"]["device_received"] is False
    live(database, revision, stamp + 60200, seam + 600000)
    with database.begin() as db:
        evaluate(db, ident, now=stamp + 60200)
        notes = system_notes(db)
        assert len(notes) == 2 and notes[1].payload["incident_id"] == incident + ":recovery"
        assert "incident" not in db.get(ChartAlert, ident).runtime


def test_short_fault_recovery_never_queues_phone(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, notify_ntfy=True)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        execution.transition(db, alert, state="recovering", now=stamp, reason="confirmation_source_unavailable")
        execution.transition(db, alert, state="monitoring", now=stamp + 59999)
        assert len(system_notes(db)) == 0
        assert alert.runtime["last_incident"]["recovered_at"] == stamp + 59999


def test_irrecoverable_gap_notifies_immediately_and_recovery_retains_interval(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, notify_ntfy=True)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        execution.gap(db, alert, now=stamp, reason="input_retention_exceeded", start=stamp - 1000, end=stamp)
        execution.transition(db, alert, state="monitoring", now=stamp + 1)
        notes = system_notes(db)
        assert len(notes) == 2
        assert "未能判定是否触发" in notes[0].payload["message"]
        assert "未能判定是否触发" in notes[1].payload["message"]
        assert alert.runtime["last_gap"]["start"] == stamp - 1000
        first = notes[0].payload["incident_id"]
        execution.transition(db, alert, state="blocked", now=stamp + 2, reason="realtime_disabled")
        assert len(system_notes(db)) == 3 and system_notes(db)[2].payload["incident_id"] != first


def test_notification_configuration_loss_is_visible_and_does_not_claim_delivery(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, notify_ntfy=True)
    monkeypatch.setattr(settings, "ntfy_topic", "")
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        execution.transition(db, alert, state="blocked", now=stamp, reason="realtime_disabled")
        note = system_notes(db)[0]
        assert db.scalar(select(Outbox)).status == "pending"
        execution.refresh_phone(db, alert, now=stamp)
        result = execution_dict(alert, current_version(db, alert), at=stamp)
        assert result["notification"]["status"] == "blocked_configuration"
        assert result["phone_configuration"]["reason_code"] == "phone_topic_missing"
        note.status = "server_accepted"
        monkeypatch.setattr(settings, "ntfy_topic", "fixture-restored")
        execution.refresh_phone(db, alert, now=stamp + 1)
        assert alert.runtime["execution_notification"]["status"] == "server_accepted"
        assert alert.runtime["execution_notification"]["device_received"] is False
        assert len(system_notes(db)) == 1


@pytest.mark.parametrize("invalid,code", [("topic", "phone_topic_missing"), ("disabled", "phone_delivery_disabled")])
def test_create_and_resume_validate_phone_configuration_without_network(database, monkeypatch, invalid, code):
    ident, composite, _, _, stamp = armed(database, monkeypatch, notify_ntfy=True)
    monkeypatch.setattr(settings, "ntfy_topic" if invalid == "topic" else "delivery_enabled", "" if invalid == "topic" else False)
    with database.begin() as db:
        with pytest.raises(NotificationConfigurationError) as error:
            create(db, "invalid-phone", config(composite, notify_ntfy=True), at=stamp)
        assert error.value.field == "notify_ntfy" and error.value.code == code
        alert = db.get(ChartAlert, ident)
        lifecycle(db, ident, alert.version, "pause", expected_revision=alert.control_revision,
            request_id="pause-phone", at=stamp)
        with pytest.raises(NotificationConfigurationError):
            lifecycle(db, ident, alert.version, "resume", expected_revision=alert.control_revision,
                request_id="resume-phone", at=stamp + 1)
        assert alert.status == "paused"


def test_notifications_runtime_detects_rule_not_taken_over(database, monkeypatch):
    from alerts import notification_runtime, runtime_health

    ident, _, _, _, stamp = armed(database, monkeypatch)
    monkeypatch.setattr(runtime_health, "expected_roles", lambda: ())
    monkeypatch.setattr("alerts.storage.now_ms", lambda: stamp + 60001)
    notification_runtime.inspect_health()
    notification_runtime.inspect_health()
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["reason_code"] == "worker_not_taken_over"
        assert alert.runtime.get("last_checked_at") is None
        assert alert.runtime.get("last_evaluated_at") is None
        assert alert.runtime["last_patrolled_at"] == stamp + 60001
        assert db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == "notice_source",
            Audit.details["source_id"].as_string() == ident)) == 1


def test_alive_worker_without_progress_is_detected_then_recovers(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar")
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    publish(database, ident, stamp + 100, "1.119", 1)
    with database.begin() as db:
        execution.patrol(db, now=stamp + 101)
        alert = db.get(ChartAlert, ident)
        alert.runtime = {**alert.runtime, "last_checked_at": stamp + 60100}
        execution.patrol(db, now=stamp + 60101)
        assert alert.runtime["reason_code"] == "worker_progress_stalled"
        assert alert.runtime["cursor"] == 0
        assert len(evaluate(db, ident, now=stamp + 60102)) == 1
        assert alert.runtime["cursor"] == 1


def test_no_pending_input_does_not_look_like_stalled_worker(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="close")
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        execution.patrol(db, now=stamp + 60001)
        execution.patrol(db, now=stamp + 120002)
        assert db.get(ChartAlert, ident).runtime["reason_code"] is None


def test_legacy_auto_pause_stays_paused_and_receives_one_actionable_notice(database, monkeypatch):
    from alerts.live_pricing import desired_datasets

    ident, _, _, _, stamp = armed(database, monkeypatch, notify_ntfy=True)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        alert.status, alert.runtime = "paused", {"demand_hold": "stale_input"}
        execution.patrol(db, now=stamp + 1)
        execution.patrol(db, now=stamp + 2)
        assert alert.status == "paused" and alert.count == 0
        assert alert.runtime["reason_code"] == "legacy_auto_paused"
        assert len(system_notes(db)) == 1
        assert db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == "notice_source",
            Audit.details["source_id"].as_string() == ident)) == 1
    # Pausing this alert cannot retire an explicitly enabled composite stream.
    assert set(desired_datasets(settings.oanda_account_id)) == {"EUR_USD"}


def test_execution_projection_distinguishes_creation_expiry_and_count(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, expires_at=166201000)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        version = current_version(db, alert)
        assert execution_dict(alert, version, at=stamp)["label"] == "准备中"
        evaluate(db, ident, now=stamp)
        assert execution_dict(alert, version, at=stamp)["label"] == "监控中"
        assert execution_dict(alert, version, at=alert.expires_at)["label"] == "已到期"
        alert.status = "completed"
        assert execution_dict(alert, version, at=stamp)["label"] == "触发次数已用完"


@pytest.mark.parametrize("response,expected", [(500, "pending"), (401, "blocked"), (403, "blocked"),
    ("timeout", "pending"), (200, "accepted"), ("quiet", "pending")])
def test_execution_phone_http_outcomes(database, monkeypatch, response, expected):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import httpx
    from alerts import notify
    from alerts.storage import DeliveryAttempt, Preference

    ident, _, _, _, stamp = armed(database, monkeypatch, notify_ntfy=True)
    seen = []
    release = threading.Event()

    class Receiver(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            if response == "timeout":
                release.wait(3)
                return
            self.send_response(response)
            self.end_headers()
            self.wfile.write(b'{"id":"local-test-receipt"}')

    with ThreadingHTTPServer(("127.0.0.1", 0), Receiver) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        monkeypatch.setattr(settings, "ntfy_url", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setattr(notify, "now_ms", lambda: stamp)
        with database.begin() as db:
            alert = db.get(ChartAlert, ident)
            execution.transition(db, alert, state="blocked", now=stamp, reason="realtime_disabled")
            if response == "quiet":
                db.merge(Preference(key="notifications", value={"quiet_enabled": True,
                    "timezone": "UTC", "quiet_start": "00:00", "quiet_end": "00:00"}))
        try:
            with httpx.Client(timeout=0.5, trust_env=False) as client:
                assert notify.deliver_once(client) is (response != "quiet")
            with database.begin() as db:
                row = db.scalar(select(Outbox))
                note = db.get(Notification, row.notification_id)
                assert row.status == expected
                alert = db.get(ChartAlert, ident)
                execution.refresh_phone(db, alert, now=stamp)
                projected = alert.runtime["execution_notification"]
                assert not projected["device_received"]
                if response == "quiet":
                    assert not seen and note.status == "quiet" and row.next_at > stamp
                else:
                    assert len(seen) == 1 and seen[0]["topic"] == settings.ntfy_topic
                    assert seen[0]["click"].endswith("?panel=alerts&alert=" + ident)
                    attempt = db.scalar(select(DeliveryAttempt))
                    if response == 200:
                        assert note.status == projected["status"] == "server_accepted"
                        assert attempt.status == "accepted"
                    else:
                        assert note.status == "delivery_error"
                        if response == "timeout":
                            assert attempt.details["error"] == "ReadTimeout"
                        else:
                            assert attempt.details["status_code"] == response
                        if expected == "blocked":
                            assert projected["reason_code"] == "phone_permission_denied"
                        else:
                            assert row.next_at > stamp
        finally:
            release.set()
            server.shutdown()
            worker.join(2)


def test_incident_projection_is_idempotent_and_keeps_recovery(database, monkeypatch):
    from alerts.notification_center import SUBJECT, list_events, project

    ident, _, _, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        execution.transition(db, alert, state="recovering", now=stamp, reason="price_input_unavailable")
        execution.transition(db, alert, state="recovering", now=stamp + 1, reason="provider_maintenance")
        execution.gap(db, alert, now=stamp + 2, reason="price_sample_gap", start=stamp, end=stamp + 2)
        execution.transition(db, alert, state="monitoring", now=stamp + 3)
        execution.transition(db, alert, state="blocked", now=stamp + 4, reason="realtime_disabled")
        project(db)
        assert project(db) == 0
        events = list_events(db, SUBJECT, {"audience": "system", "source": "chart_alert_execution"})["events"]
        assert len(events) == 2
        assert all(row["context"]["alert_id"] == ident for row in events)
        assert sorted(row["incident"]["closed_at"] is not None for row in events) == [False, True]
        assert all(row["incident"]["count"] == 1 for row in events)
        assert alert.runtime["last_gap"]["unrecoverable"] is True


@pytest.mark.parametrize("action", ["edit", "restart"])
def test_new_configuration_or_run_keeps_fault_until_actual_recovery(database, monkeypatch, action):
    from alerts.chart_alert_service import edit
    from alerts.notification_center import SUBJECT, list_events, project

    ident, composite, _, _, stamp = armed(database, monkeypatch, mode="intrabar")
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        execution.transition(db, alert, state="recovering", now=stamp, reason="price_input_unavailable")
        incident = alert.runtime["incident"]["id"]
        if action == "edit":
            edit(db, ident, alert.version, config(composite, mode="intrabar"), at=stamp + 1)
        else:
            lifecycle(db, ident, alert.version, "restart", expected_revision=alert.control_revision,
                request_id="restart-fault", at=stamp + 1)
        assert alert.runtime["incident"]["id"] == incident
        evaluate(db, ident, now=stamp + 2)
        assert "incident" not in alert.runtime
        project(db)
        events = list_events(db, SUBJECT, {"audience": "system", "source": "chart_alert_execution"})["events"]
        assert len(events) == 1 and events[0]["incident"]["closed_at"] is not None


def test_calendar_close_does_not_claim_disconnected_source_recovered(database, monkeypatch):
    from alerts import composite_quotes

    ident, _, revision, seam, stamp = armed(database, monkeypatch, mode="intrabar", notify_ntfy=True)
    live(database, revision, stamp + 1, seam + 600000, connected=False)
    with database.begin() as db:
        evaluate(db, ident, now=stamp + 1)
        alert = db.get(ChartAlert, ident)
        incident = alert.runtime["incident"]["id"]
    original = composite_quotes.live_snapshot
    monkeypatch.setattr(composite_quotes, "live_snapshot", lambda *args, **kw:
        {**original(*args, **kw), "market_session": "closed"})
    with database.begin() as db:
        evaluate(db, ident, now=stamp + 2)
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["execution_state"] == "closed"
        assert alert.runtime["incident"]["id"] == incident
        assert "last_incident" not in alert.runtime
        assert all(not note.payload["incident_id"].endswith(":recovery") for note in system_notes(db))

    live(database, revision, stamp + 3, seam + 600000, connected=True)
    with database.begin() as db:
        evaluate(db, ident, now=stamp + 3)
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["execution_state"] == "closed"
        assert "incident" not in alert.runtime
        assert alert.runtime["last_incident"]["id"] == incident


def test_edit_to_complex_rule_ends_price_fault_observation_without_claiming_recovery(database, monkeypatch):
    from alerts.chart_alert_service import edit
    from alerts.notification_center import SUBJECT, list_events, project
    from test_composite_alerts import ray_condition

    ident, composite, _, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        execution.transition(db, alert, state="recovering", now=stamp, reason="confirmation_source_unavailable")
        edit(db, ident, 1, config(composite, condition=ray_condition()), at=stamp + 1)
        assert "incident" not in alert.runtime
        assert alert.runtime["last_incident"]["ended_at"] == stamp + 1
        assert "recovered_at" not in alert.runtime["last_incident"]
        project(db)
        event = list_events(db, SUBJECT, {"audience": "system", "source": "chart_alert_execution"})["events"][0]
        assert event["observation_status"] == "ended"
        assert event["incident"]["closed_at"] is None
