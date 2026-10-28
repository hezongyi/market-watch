"""Supervised projection, retention, delivery and health loops."""

import hashlib
from contextlib import contextmanager

from sqlalchemy import select, text

from . import runtime_health
from .runtime_supervisor import Loop, RuntimeGroupError, exit_if_unstopped, run_group


def build_loops():
    from . import notification_center_worker, notify

    return (
        Loop("notification_projection", notification_center_worker.run_projection),
        Loop("notification_retention", notification_center_worker.run_retention),
        Loop("notification_delivery", notify.run),
    )


@contextmanager
def ownership(engine):
    from .config import settings

    if engine.dialect.name != "postgresql":
        raise RuntimeError("Notification runtime requires PostgreSQL ownership")
    lock_id = int.from_bytes(hashlib.sha256(
        f"notification-runtime:{settings.runtime_deployment}".encode()).digest()[:8],
        "big", signed=True)
    with engine.connect() as connection:
        acquired = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_id})
        connection.commit()
        if not acquired:
            raise RuntimeError("Another notification runtime owns this deployment")
        try:
            def verify(stop):
                while not stop.is_set():
                    connection.execute(text("SELECT 1"))
                    connection.commit()
                    runtime_health.progress()
                    stop.wait(5)

            yield verify
        finally:
            try:
                connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": lock_id})
                connection.commit()
            except Exception:
                connection.invalidate()


def run(*, stop=None, loops=None, handle_signals=True):
    from .storage import bootstrap, engine

    bootstrap()
    selected = tuple(loops or build_loops())
    with ownership(engine) as verify_ownership:
        boot_id = runtime_health.boot()
        reporters = {
            loop.role: runtime_health.Progress("notifications", loop.role, boot_id)
            for loop in selected
        }
        reporters.update({
            "notification_ownership": runtime_health.Progress(
                "notifications", "notification_ownership", boot_id),
            "notification_health": runtime_health.Progress(
                "notifications", "notification_health", boot_id),
        })
        for reporter in reporters.values():
            reporter.claim()

        def wrapped(loop):
            def execute(shared_stop):
                with runtime_health.reporting(reporters[loop.role]):
                    loop.run(shared_stop)
            return Loop(loop.role, execute)

        def report_state(role, state, error):
            reporters[role].record(state=state, error=error, completed=False)

        selected += (
            Loop("notification_ownership", verify_ownership),
            Loop("notification_health", run_health),
        )
        wrapped_loops = []
        for loop in selected:
            if loop.role in ("notification_ownership", "notification_health"):
                reporter = reporters[loop.role]

                def execute(shared_stop, loop=loop, reporter=reporter):
                    with runtime_health.reporting(reporter):
                        loop.run(shared_stop)

                wrapped_loops.append(Loop(loop.role, execute))
            else:
                wrapped_loops.append(wrapped(loop))
        try:
            run_group(tuple(wrapped_loops), stop=stop, on_state=report_state,
                      handle_signals=handle_signals)
        except RuntimeGroupError as error:
            exit_if_unstopped(error)
            raise


def run_health(stop):
    from .config import settings
    from .runtime_health import progress
    from .storage import now_ms

    started_at = now_ms()
    startup_grace_until = started_at + settings.runtime_startup_grace_seconds * 1000
    while not stop.is_set():
        error = None
        try:
            inspect_health(startup_grace_until=startup_grace_until)
        except Exception as exc:
            error = exc
        progress(error=error)
        stop.wait(15)


def inspect_health(*, startup_grace_until=0):
    """Monitor fixed runtime roles and persist fault/recovery transitions."""
    from .runtime_health import MARKET_ROLES, data_roles, key
    from .storage import Preference, now_ms, transaction

    expected = tuple(f"market:{role}" for role in MARKET_ROLES if role != "market_ownership")
    expected += tuple(f"data:{role}" for role in data_roles() if role != "data_ownership")
    expected += tuple(f"notifications:{role}" for role in runtime_health.NOTIFICATION_ROLES)
    now = now_ms()
    faults = []
    with transaction() as db:
        for item in expected:
            group, role = item.split(":", 1)
            row = db.get(Preference, key(role))
            value = row.value if row else {}
            checked = value.get("checked_at")
            stale_after = value.get("stale_after_ms", 15000)
            if not value or not checked or now - checked >= stale_after or value.get("error_type"):
                category = value.get("error_type") or ("missing" if not value else "stale")
                starting = not checked and value.get("state") == "starting"
                if not ((category == "missing" or starting) and now < startup_grace_until):
                    faults.append((group, role, category))
        current = {f"{group}:{role}" for group, role, _category in faults}
        notifications_due = []
        for fault_id in current:
            key_name = "runtime_incident:" + fault_id
            row = db.get(Preference, key_name)
            value = row.value if row else {"state": "active", "opened_at": now,
                                            "last_notified_at": 0}
            newly_opened = row is None or value.get("state") != "active"
            group, role = fault_id.split(":", 1)
            category = next(category for fault_group, fault_role, category in faults
                            if fault_group == group and fault_role == role)
            value.update(state="active", observed_at=now, category=category)
            if newly_opened or now - value.get("last_notified_at", 0) >= 900_000:
                notifications_due.append(f"{group} / {role}：{category}")
                value["last_notified_at"] = now
            if row:
                row.value = value
            else:
                db.add(Preference(key=key_name, value=value))
        # Recovery is a durable state transition; it does not acknowledge an incident.
        recovered = []
        for row in db.scalars(select(Preference).where(
                Preference.key.like("runtime_incident:%"))).all():
            if row.value.get("state") == "active" and row.key.removeprefix("runtime_incident:") not in current:
                fault_id = row.key.removeprefix("runtime_incident:")
                if row.value.get("last_notified_at"):
                    recovered.append(fault_id.replace(":", " / "))
                row.value = {**row.value, "state": "recovered", "recovered_at": now}
        if notifications_due:
            _queue_system_notice(db, title="后台服务异常",
                message="以下运行角色状态异常，请检查：\n" + "\n".join(notifications_due),
                incident_id=f"runtime-faults:{now}")
        if recovered:
            _queue_system_notice(db, title="后台服务已恢复",
                message="以下运行角色已恢复正常：\n" + "\n".join(recovered),
                incident_id=f"runtime-recovery:{now}")


def _queue_system_notice(db, *, title, message, incident_id):
    from .storage import Notification, Outbox, now_ms

    note = Notification(kind="system", signal_id=None, status="pending",
                        payload={"title": title, "message": message,
                                 "incident_id": incident_id})
    db.add(note)
    db.flush()
    db.add(Outbox(notification_id=note.id, status="pending", attempts=0,
                  next_at=now_ms(),
                  lease_until=None, error=None, provider_id=None))
