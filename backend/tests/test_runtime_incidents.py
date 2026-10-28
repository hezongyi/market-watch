"""Runtime fault reminders: expectations, restart loops, maintenance and recovery."""

import sys

from sqlalchemy import func, select


def scope(monkeypatch, *, market=(), data=(), notifications=()):
    from alerts import runtime_health

    monkeypatch.setattr(runtime_health, "MARKET_ROLES", tuple(market))
    monkeypatch.setattr(runtime_health, "data_roles", lambda: tuple(data))
    monkeypatch.setattr(runtime_health, "NOTIFICATION_ROLES", tuple(notifications))


def healthy(db, role, *, checked_at=None):
    from alerts import runtime_health
    from alerts.storage import Preference, now_ms

    row = db.get(Preference, runtime_health.key(role))
    value = {
        "role": role,
        "state": "idle",
        "checked_at": now_ms() if checked_at is None else checked_at,
        "stale_after_ms": 15000,
        "error_type": None,
    }
    if row:
        row.value = value
    else:
        db.add(Preference(key=runtime_health.key(role), value=value))


def notes(database):
    from alerts.storage import Notification

    with database.begin() as db:
        return [note.payload for note in db.scalars(
            select(Notification).order_by(Notification.created_at, Notification.id))]


def test_restarted_worker_does_not_repush_an_active_fault(database, monkeypatch):
    from alerts import notification_runtime
    from alerts.storage import Notification, Preference, now_ms

    scope(monkeypatch, market=("chart_alert",))
    notification_runtime.inspect_health()
    # A new notification worker has no memory of the incident.
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert len(list(db.scalars(select(Notification)))) == 1
        incident = db.get(Preference, "runtime_incident:market:chart_alert")
        assert incident.value["state"] == "active" and incident.value["last_notified_at"]
        # The reminder interval, not a restart, decides the next push.
        incident.value = {**incident.value, "last_notified_at": now_ms() - 900_000}
    notification_runtime.inspect_health()
    assert len(notes(database)) == 2


def test_one_stuck_role_is_not_masked_by_other_heartbeats(database, monkeypatch):
    from alerts import notification_runtime

    scope(monkeypatch, market=("pricing", "chart_alert"))
    with database.begin() as db:
        healthy(db, "pricing")
    notification_runtime.inspect_health()
    message = notes(database)[0]["message"]
    assert "market / chart_alert" in message
    assert "market / pricing" not in message


def test_replaced_instance_writes_neither_hide_nor_forge_faults(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Preference, now_ms

    scope(monkeypatch, market=("chart_alert",))
    old = runtime_health.Progress("market", "chart_alert", "boot-old")
    old.claim()
    old.record(state="degraded", error="RuntimeError")
    new = runtime_health.Progress("market", "chart_alert", "boot-new")
    new.claim()
    new.record()
    # A late write from the replaced instance cannot resurrect its fault.
    old.record(state="degraded", error="RuntimeError")
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None
    # Nor can it refresh the replacement's heartbeat once that one stops.
    with database.begin() as db:
        row = db.get(Preference, runtime_health.key("chart_alert"))
        row.value = {**row.value, "checked_at": now_ms() - 60_000}
    old.record()
    notification_runtime.inspect_health()
    message = notes(database)[0]["message"]
    assert "market / chart_alert" in message and "stale" in message


def test_detection_does_not_need_the_api_process(database, monkeypatch):
    from alerts import notification_runtime

    scope(monkeypatch, market=("chart_alert",))
    # The API may be stopped; importing it inside the inspection would fail here.
    monkeypatch.setitem(sys.modules, "alerts.api", None)
    notification_runtime.inspect_health()
    assert len(notes(database)) == 1


def test_healthy_roles_without_active_rules_report_nothing(database, monkeypatch):
    from alerts import notification_runtime
    from alerts.storage import ChartAlert, Notification

    scope(monkeypatch, market=("chart_alert",), notifications=("notification_delivery",))
    with database.begin() as db:
        healthy(db, "chart_alert")
        healthy(db, "notification_delivery")
        assert db.scalar(select(func.count()).select_from(ChartAlert)) == 0
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None


def test_recovery_is_notified_once(database, monkeypatch):
    from alerts import notification_runtime

    scope(monkeypatch, market=("chart_alert",))
    notification_runtime.inspect_health()
    with database.begin() as db:
        healthy(db, "chart_alert")
    notification_runtime.inspect_health()
    notification_runtime.inspect_health()
    notification_runtime.inspect_health()
    recovered = [payload for payload in notes(database) if "已恢复" in payload["message"]]
    assert len(notes(database)) == 2 and len(recovered) == 1


def test_repeated_starts_inside_one_window_are_reported_once_and_recover(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Preference

    scope(monkeypatch, market=("chart_alert",))
    boots = [runtime_health.Progress("market", "chart_alert", f"boot-{index}")
             for index in range(4)]
    for reporter in boots:
        reporter.claim()
    boots[-1].record()
    notification_runtime.inspect_health()
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert len(list(db.scalars(select(Notification)))) == 1
        incident = db.get(Preference, "runtime_incident:runtime:boot_loop")
        assert incident.value["state"] == "active" and incident.value["category"] == "restart_loop"
        # Once the window rolls over the replacement is healthy again.
        row = db.get(Preference, runtime_health.key("chart_alert"))
        row.value = {**row.value, "starts": [row.value["starts"][-1]]}
    notification_runtime.inspect_health()
    assert len(notes(database)) == 2
    assert any("已恢复" in payload["message"] for payload in notes(database))


def test_a_normal_redeploy_is_not_a_restart_loop(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification

    scope(monkeypatch, market=("chart_alert",))
    boots = [runtime_health.Progress("market", "chart_alert", f"boot-{index}")
             for index in range(runtime_health.RESTART_LIMIT)]
    for reporter in boots:
        reporter.claim()
    boots[-1].record()
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None


def test_bounded_maintenance_window_pauses_checks_and_expires(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Preference, now_ms

    scope(monkeypatch, market=("chart_alert",))
    with database.begin() as db:
        runtime_health.maintain(db, minutes=30)
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None
        assert db.get(Preference, "runtime_incident:market:chart_alert") is None
    # An expired window restores detection without another action.
    with database.begin() as db:
        runtime_health.maintain(db, minutes=1, at=now_ms() - 120_000)
    notification_runtime.inspect_health()
    assert "market / chart_alert" in notes(database)[0]["message"]


def test_maintenance_never_counts_as_recovery(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Preference

    scope(monkeypatch, market=("chart_alert",))
    notification_runtime.inspect_health()
    with database.begin() as db:
        runtime_health.maintain(db, minutes=10)
    notification_runtime.inspect_health()
    with database.begin() as db:
        incident = db.get(Preference, "runtime_incident:market:chart_alert")
        assert incident.value["state"] == "active"
        runtime_health.clear_maintenance(db)
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.get(Preference, "runtime_incident:market:chart_alert").value["state"] == "active"
    assert len(notes(database)) == 1


def test_chart_alert_is_only_expected_when_the_profile_starts_it(database, monkeypatch):
    from alerts import notification_runtime
    from alerts.config import settings
    from alerts.storage import Notification

    scope(monkeypatch, market=("chart_alert",))
    monkeypatch.setattr(settings, "market_runtime_chart_alert_enabled", False)
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None
    monkeypatch.setattr(settings, "market_runtime_chart_alert_enabled", True)
    notification_runtime.inspect_health()
    assert "market / chart_alert" in notes(database)[0]["message"]


def test_expected_data_roles_follow_enabled_sources(monkeypatch):
    from alerts.config import settings
    from alerts.runtime_health import expected_roles

    monkeypatch.setattr(settings, "yahoo_enabled", False)
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "rest_batch")
    assert "data:provider_live_yahoo" not in expected_roles()
    assert "data:provider_live_oanda" not in expected_roles()
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    assert "data:provider_live_yahoo" in expected_roles()
    assert "data:provider_live_oanda" in expected_roles()


def test_scoped_maintenance_window_leaves_other_groups_checked(database, monkeypatch):
    from alerts import notification_runtime, runtime_health

    scope(monkeypatch, market=("chart_alert",), data=("chart_history",))
    with database.begin() as db:
        runtime_health.maintain(db, minutes=30, groups=("market",))
    notification_runtime.inspect_health()
    message = notes(database)[0]["message"]
    assert "data / chart_history" in message
    assert "market / chart_alert" not in message


def test_restart_scan_is_scoped_to_this_deployment(database, monkeypatch):
    from alerts import runtime_health
    from alerts.config import settings
    from alerts.storage import Preference, now_ms

    monkeypatch.setattr(settings, "runtime_deployment", "stage_5")
    with database.begin() as db:
        db.add(Preference(key="worker_health:runtime:stageX5:chart_alert",
                          value={"role": "chart_alert", "starts": [now_ms()] * 4}))
        assert runtime_health.restarts(db) == []


def test_health_loop_keeps_one_startup_grace_and_survives_a_failed_inspection(
        database, monkeypatch):
    import time

    from alerts import notification_runtime, runtime_health
    from alerts.config import settings

    seen, errors = [], []

    class Stop:
        def __init__(self):
            self.checks = 0

        def is_set(self):
            self.checks += 1
            return self.checks > 2

        def wait(self, seconds):
            self.seconds = seconds

    def inspect(**kwargs):
        seen.append(kwargs["startup_grace_until"])
        if len(seen) == 1:
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(notification_runtime, "inspect_health", inspect)
    monkeypatch.setattr(runtime_health, "progress", lambda **kwargs: errors.append(kwargs))
    before = time.time() * 1000
    notification_runtime.run_health(Stop())
    grace = settings.runtime_startup_grace_seconds * 1000
    assert len(seen) == 2 and len(errors) == 2
    assert isinstance(errors[0]["error"], RuntimeError) and errors[1]["error"] is None
    assert before + grace - 1000 <= seen[0] <= time.time() * 1000 + grace


def test_maintenance_command_records_and_clears_the_window(database, monkeypatch):
    import sys

    from alerts import notification_runtime, runtime_health, storage

    monkeypatch.setattr(storage, "bootstrap", lambda: None)
    monkeypatch.setattr(sys, "argv", ["notification_runtime", "--maintenance-minutes", "20"])
    notification_runtime.main()
    with database.begin() as db:
        assert runtime_health.maintenance(db)["until"] > 0
    monkeypatch.setattr(sys, "argv", ["notification_runtime", "--end-maintenance"])
    notification_runtime.main()
    with database.begin() as db:
        assert runtime_health.maintenance(db) is None



def test_notification_role_deadlines_exceed_their_own_idle_period():
    from alerts import notification_runtime

    idle_periods = {
        "notification_projection": 0.5,
        "notification_retention": 60,
        "notification_delivery": 2,
        "notification_ownership": 5,
        "notification_health": 15,
    }
    for role, seconds in idle_periods.items():
        assert notification_runtime.deadline_ms(role) > seconds * 1000


def test_retention_idle_loop_is_not_reported_stale_inside_its_deadline(database, monkeypatch):
    from alerts import notification_runtime, runtime_health, storage
    from alerts.storage import Notification

    scope(monkeypatch, notifications=("notification_retention",))
    clock = [100_000_000]
    monkeypatch.setattr(runtime_health, "now_ms", lambda: clock[0])
    monkeypatch.setattr(storage, "now_ms", lambda: clock[0])
    reporter = runtime_health.Progress(
        "notifications", "notification_retention", "boot",
        deadline_ms=notification_runtime.deadline_ms("notification_retention"))
    reporter.claim()
    reporter.record()

    # One whole 60s poll period passes before the next check; that is normal idle.
    clock[0] += 60_000
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None

    # Beyond the role's own deadline the same record is a real fault.
    clock[0] += 30_000
    notification_runtime.inspect_health()
    assert "notifications / notification_retention" in notes(database)[0]["message"]


def test_shared_default_window_would_report_a_sixty_second_poll_stale(database, monkeypatch):
    """The pre-fix 15s default window faults a healthy 60s retention loop."""
    from alerts import notification_runtime, runtime_health, storage

    scope(monkeypatch, notifications=("notification_retention",))
    clock = [100_000_000]
    monkeypatch.setattr(runtime_health, "now_ms", lambda: clock[0])
    monkeypatch.setattr(storage, "now_ms", lambda: clock[0])
    reporter = runtime_health.Progress("notifications", "notification_retention", "boot")
    reporter.claim()
    reporter.record()

    clock[0] += 16_000
    notification_runtime.inspect_health()
    assert "notifications / notification_retention" in notes(database)[0]["message"]

