"""Supervised projection, retention, delivery and health loops.

The module command records or clears one bounded planned-maintenance window.
"""

import argparse
import hashlib
from contextlib import contextmanager

from sqlalchemy import select, text

from . import runtime_health
from .runtime_supervisor import Loop, RuntimeGroupError, exit_if_unstopped, run_group

# Each role's deadline must exceed its own idle period: retention polls once a
# minute and the health loop every 15s. data and market set the same per role.
LOOP_DEADLINES = {
    "notification_projection": 60_000,
    "notification_retention": 90_000,
    "notification_delivery": 60_000,
    "notification_ownership": 60_000,
    "notification_health": 60_000,
}


def deadline_ms(role):
    return LOOP_DEADLINES.get(role, 60_000)


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
            loop.role: runtime_health.Progress(
                "notifications", loop.role, boot_id, deadline_ms=deadline_ms(loop.role))
            for loop in selected
        }
        reporters.update({
            role: runtime_health.Progress(
                "notifications", role, boot_id, deadline_ms=deadline_ms(role))
            for role in ("notification_ownership", "notification_health")
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
    """Monitor configured runtime roles and persist fault/recovery transitions."""
    from .runtime_health import expected_roles, key, maintenance, paused, restarts
    from .storage import Preference, now_ms, transaction

    now = now_ms()
    with transaction() as db:
        # A bounded maintenance window pauses role checks; it is never recovery.
        window = maintenance(db, at=now)
        faults = []
        for item in expected_roles():
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
        # Repeated starts inside one window are a deploy-independent fault of the
        # replacement state itself, deduplicated across every churning role.
        if restarts(db, at=now):
            faults.append(("runtime", "boot_loop", "restart_loop"))
        faults = [fault for fault in faults if not paused(window, fault[0])]
        current = {f"{group}:{role}" for group, role, _category in faults}
        notifications_due = []
        for fault_id in current:
            key_name = "runtime_incident:" + fault_id
            row = db.get(Preference, key_name)
            # A copy, never the column's own dict: an in-place edit leaves the
            # attribute unchanged and the reminder time never reaches the row.
            value = dict(row.value) if row else {"state": "active", "opened_at": now,
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
        # A paused group keeps its incident open because maintenance is not recovery.
        recovered = []
        for row in db.scalars(select(Preference).where(
                Preference.key.like("runtime_incident:%"))).all():
            fault_id = row.key.removeprefix("runtime_incident:")
            if (row.value.get("state") != "active" or fault_id in current
                    or paused(window, fault_id.split(":", 1)[0])):
                continue
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


def main():
    parser = argparse.ArgumentParser(description="Pause or resume runtime expectation checks.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--maintenance-minutes", type=int,
                        help="bounded planned-maintenance window for this deployment")
    parser.add_argument("--maintenance-group", action="append", default=[],
                        help="role group to pause; omit to pause every group, including runtime")
    action.add_argument("--end-maintenance", action="store_true",
                        help="clear the maintenance window and resume checks")
    args = parser.parse_args()
    if args.maintenance_minutes is not None and args.maintenance_minutes < 1:
        parser.error("--maintenance-minutes must be positive")
    from .runtime_health import clear_maintenance, maintain
    from .storage import bootstrap, transaction

    bootstrap()
    with transaction() as db:
        if args.end_maintenance:
            clear_maintenance(db)
            print("runtime maintenance window cleared")
        else:
            window = maintain(db, minutes=args.maintenance_minutes,
                              groups=args.maintenance_group)
            print(f"runtime maintenance until {window['until']}")


if __name__ == "__main__":
    main()
