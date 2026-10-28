from sqlalchemy import func, select


def test_runtime_health_notices_are_deduplicated_and_recover(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Outbox, Preference, now_ms

    monkeypatch.setattr(runtime_health, "MARKET_ROLES", ("chart_alert",))
    monkeypatch.setattr(runtime_health, "data_roles", lambda: ())

    notification_runtime.inspect_health()
    notification_runtime.inspect_health()
    with database.begin() as db:
        notes = list(db.scalars(select(Notification)))
        assert len(notes) == 1
        assert notes[0].kind == "system"
        assert "chart_alert" in notes[0].payload["message"]
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1

        db.add(Preference(key=runtime_health.key("chart_alert"), value={
            "checked_at": now_ms(), "stale_after_ms": 15000, "error_type": None,
        }))

    notification_runtime.inspect_health()
    notification_runtime.inspect_health()
    with database.begin() as db:
        notes = list(db.scalars(select(Notification).order_by(Notification.created_at)))
        assert len(notes) == 2
        assert notes[1].kind == "system"
        assert "已恢复" in notes[1].payload["message"]
        assert db.scalar(select(func.count()).select_from(Outbox)) == 2


def test_notification_profile_owns_projection_retention_and_delivery_loops():
    from alerts.notification_runtime import build_loops

    roles = [loop.role for loop in build_loops()]
    assert roles == [
        "notification_projection", "notification_retention", "notification_delivery",
    ]


def test_missing_runtime_roles_wait_for_startup_grace(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification
    from sqlalchemy import select

    monkeypatch.setattr(runtime_health, "MARKET_ROLES", ("chart_alert",))
    monkeypatch.setattr(runtime_health, "data_roles", lambda: ())
    notification_runtime.inspect_health(startup_grace_until=10**15)
    with database.begin() as db:
        assert db.scalar(select(Notification)) is None


def test_notification_worker_roles_are_in_health_scope(database, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Preference, now_ms
    from sqlalchemy import select

    monkeypatch.setattr(runtime_health, "MARKET_ROLES", ())
    monkeypatch.setattr(runtime_health, "data_roles", lambda: ())
    with database.begin() as db:
        db.add(Preference(key=runtime_health.key("notification_delivery"), value={
            "state": "idle", "checked_at": now_ms(), "stale_after_ms": 15000,
            "error_type": "RuntimeError",
        }))
    notification_runtime.inspect_health()
    with database.begin() as db:
        assert "notification_delivery" in db.scalar(select(Notification)).payload["message"]
