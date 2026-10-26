"""Monitor liveness, individual data readiness and delivery backlog stay distinct."""

from alerts import chart_alert_health as health
from alerts.chart_alert_service import create
from alerts.storage import Preference
from test_chart_alert_service import config


def test_empty_loop_is_healthy_and_heartbeat_writes_are_bounded(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(health, "now_ms", lambda: clock[0])
    heartbeat = health.Heartbeat()
    heartbeat.record()
    with database() as db:
        first = db.get(Preference, health.KEY).value
        report = health.summary(db, at=clock[0])
        assert report["loop"]["state"] == "running"
        assert report["loop"]["owner"]["role"] == "api"
        assert report["rules"]["active"] == 0
    clock[0] += 1000
    heartbeat.record()
    with database() as db:
        assert db.get(Preference, health.KEY).value == first
    clock[0] += health.HEARTBEAT_MS
    heartbeat.record()
    with database() as db:
        assert health.summary(db, at=clock[0])["loop"]["last_success_at"] == clock[0]
        assert health.summary(db, at=clock[0] + health.STALE_MS + 1)["loop"]["state"] == "stale"


def test_rule_waiting_closed_or_error_does_not_imply_monitor_failure(database, monkeypatch):
    monkeypatch.setattr(health, "now_ms", lambda: 100000)
    heartbeat = health.Heartbeat()
    with database.begin() as db:
        for state in ("warming", "ready", "blocked", "stale", "error"):
            row = create(db, state, config(name=state), at=0)
            row.health = state
    heartbeat.record()
    with database() as db:
        report = health.summary(db, at=100000)
        assert report["loop"]["state"] == "running"
        assert report["rules"] == {"active": 5, "blocked": 1, "stale": 1, "error": 1, "waiting": 1, "ready": 1}
    heartbeat.record("RuntimeError")
    with database() as db:
        assert health.summary(db, at=100000)["loop"]["state"] == "error"
    heartbeat.record()
    with database() as db:
        loop = health.summary(db, at=100000)["loop"]
        assert loop["state"] == "running" and loop["recent_error"] == "RuntimeError"
    heartbeat.record(stopped=True)
    with database() as db:
        assert health.summary(db, at=100000)["loop"]["state"] == "stopped"
