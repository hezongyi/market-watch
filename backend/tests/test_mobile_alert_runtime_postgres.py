"""Actual monitor loop, committed PostgreSQL inputs and a local-only push receiver."""

import json
import os
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from alerts import alert_monitor, chart_alert_worker, notification_center_worker, notify
from alerts.chart_alert_application import read
from alerts.chart_alert_service import lifecycle
from alerts.config import settings
from alerts.storage import ChartAlert, NoticeEvent, Notification, Outbox, SignalRow
from sqlalchemy import func, select
from test_composite_alerts import armed, ray_condition
from test_price_alert_settlement import publish
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Task-owned PostgreSQL required")


def wait_for(probe, *, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        threading.Event().wait(.03)
    raise AssertionError("Real monitor failed to make expected committed progress")


class PollWakeup:
    """No dependency on the host default DB URL for the optimization-only LISTEN."""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def prepare(self):
        pass

    def wait(self, seconds, stop):
        stop.wait(seconds)


@contextmanager
def running_monitor():
    stop, errors = threading.Event(), []

    def run():
        try:
            alert_monitor.run(stop, period=.05, wakeup=PollWakeup())
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(10)
        assert not thread.is_alive(), "Monitor must stop cleanly before schema retirement"
        assert not errors


def test_actual_monitor_takeover_trigger_restart_projection_and_delivery_retry(provider_pg, monkeypatch):
    database, _ = provider_pg
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", notify_ntfy=True,
                                  late_delivery="notify")
    clock = [stamp]
    monkeypatch.setattr(chart_alert_worker, "now_ms", lambda: clock[0])
    monkeypatch.setattr(notify, "now_ms", lambda: clock[0])

    def row():
        with database() as db:
            return read(db, ident)

    with running_monitor():
        wait_for(lambda: row()["execution"]["taken_over_at"])
        assert row()["execution"]["state"] == "monitoring"
        clock[0] = stamp + 100
        publish(database, ident, clock[0], "1.119", 1)
        wait_for(lambda: row()["count"] == 1)

    # The same persisted inputs must not retrigger when a fresh monitor starts.
    clock[0] += 100
    with running_monitor():
        wait_for(lambda: row()["execution"]["last_checked_at"] == clock[0])
        assert row()["count"] == 1
        with database.begin() as db:
            r = db.get(ChartAlert, ident)
            lifecycle(db, ident, r.version, "pause", expected_revision=r.control_revision,
                      request_id="runtime-pause", at=clock[0])
        clock[0] += 100
        publish(database, ident, clock[0], "1.110", 2)
        assert row()["status"] == "paused"
        with database.begin() as db:
            r = db.get(ChartAlert, ident)
            lifecycle(db, ident, r.version, "resume", expected_revision=r.control_revision,
                      request_id="runtime-resume", at=clock[0])
        wait_for(lambda: row()["execution"]["last_checked_at"] == clock[0])
        assert row()["count"] == 1, "Resume establishes a baseline without synthetic crossing"

    assert notification_center_worker.once() >= 1
    with database() as db:
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.scalar(select(func.count()).select_from(NoticeEvent).where(NoticeEvent.source_kind == "chart_alert")) == 1

    received = []

    class Sink(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            payload = b'{"id":"local-only-receipt"}'
            self.send_response(503 if len(received) == 1 else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    sink = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    server_thread = threading.Thread(target=sink.serve_forever, daemon=True)
    server_thread.start()
    monkeypatch.setattr(settings, "ntfy_url", f"http://127.0.0.1:{sink.server_port}")
    monkeypatch.setattr(settings, "ntfy_token", "")
    try:
        with httpx.Client(trust_env=False) as client:
            notify.deliver_once(client)
            with database.begin() as db:
                task = db.scalar(select(Outbox))
                assert task.attempts == 1 and task.status == "pending"
                task.next_at = clock[0]
            notify.deliver_once(client)
        with database() as db:
            assert db.scalar(select(Notification.status)) == "server_accepted"
            assert db.scalar(select(Outbox.attempts)) == 2
            assert db.get(ChartAlert, ident).count == 1
            assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert len(received) == 2
        assert received[0]["message"] == received[1]["message"]
    finally:
        sink.shutdown()
        sink.server_close()
        server_thread.join(5)


def test_non_price_rule_check_is_not_confused_with_new_evaluation(provider_pg, monkeypatch):
    database, _ = provider_pg
    ident, _, _, _, stamp = armed(database, monkeypatch, condition=ray_condition())
    with database.begin() as db:
        chart_alert_worker.evaluate(db, ident, now=stamp)
        first = read(db, ident)
        assert first["execution"] is None
        assert first["activity"]["taken_over_at"] == stamp
        assert first["activity"]["last_evaluated_at"] == stamp
        assert str(first["activity"]["last_outcome"]).endswith("_baseline")
    with database.begin() as db:
        chart_alert_worker.evaluate(db, ident, now=stamp + 100)
        second = read(db, ident)
        assert second["activity"]["last_checked_at"] == stamp + 100
        assert second["activity"]["last_evaluated_at"] == stamp, "Repeated input is not a new judgment"
