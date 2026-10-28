"""Bounded monitor heartbeat; rule data health is a separate fact."""

import os
import uuid

from sqlalchemy import func, select

from .storage import ChartAlert, Notification, Outbox, Preference, SignalRow, now_ms, transaction

KEY = "chart_alert_monitor_health"
HEARTBEAT_MS = 15000
STALE_MS = 60000


class Heartbeat:
    def __init__(self):
        self.owner = {"role": "market-runtime", "pid": os.getpid(), "run_id": str(uuid.uuid4())}
        self.value = {"owner": self.owner, "started_at": now_ms(), "state": "starting",
                      "last_success_at": None, "recent_error": None, "recent_error_at": None}
        self.saved_at = None
        self.saved_state = None

    def record(self, error=None, *, stopped=False):
        stamp = now_ms()
        state = "stopped" if stopped else "error" if error else "running"
        self.value = {**self.value, "state": state, "heartbeat_at": stamp}
        if error:
            self.value.update(recent_error=error, recent_error_at=stamp)
        elif not stopped:
            self.value["last_success_at"] = stamp
        if (self.saved_at is not None and state == self.saved_state
                and stamp - self.saved_at < HEARTBEAT_MS):
            return
        with transaction() as db:
            row = db.get(Preference, KEY)
            if row is None:
                db.add(Preference(key=KEY, value=dict(self.value)))
            else:
                row.value = dict(self.value)
        self.saved_at, self.saved_state = stamp, state


def summary(db, *, at=None):
    from .runtime_health import key
    from .runtime_health import summary as runtime_summary

    stamp = now_ms() if at is None else at
    row = db.get(Preference, KEY)
    loop = dict(row.value) if row else {"state": "unknown", "owner": {"role": "market-runtime"},
        "last_success_at": None, "recent_error": None, "recent_error_at": None}
    if loop.get("state") in ("starting", "running", "error") and stamp - loop.get("heartbeat_at", 0) > STALE_MS:
        loop["state"] = "stale"
    # Runtime records are fenced by boot ID. Retain the old shape for clients,
    # and read the legacy key only when upgrading a pre-profile deployment.
    if db.get(Preference, key("chart_alert")):
        role = runtime_summary(db, ("chart_alert",), at=stamp)[0]
        loop = {**role, "owner": {"role": "market-runtime", "run_id": role["boot_id"]},
                "heartbeat_at": role.get("checked_at"),
                "recent_error": role.get("error_type")}
    groups = dict(db.execute(select(ChartAlert.health, func.count()).where(
        ChartAlert.status == "active").group_by(ChartAlert.health)).all())
    backlog = select(Outbox).join(Notification, Notification.id == Outbox.notification_id).join(
        SignalRow, SignalRow.id == Notification.signal_id).where(
        SignalRow.chart_alert_id.is_not(None), SignalRow.watch_id.is_(None),
        Outbox.status.in_(("pending", "sending", "blocked"))).subquery()
    delivery = dict(db.execute(select(backlog.c.status, func.count()).group_by(backlog.c.status)).all())
    return {"loop": loop, "rules": {"active": sum(groups.values()),
        "blocked": groups.get("blocked", 0), "stale": groups.get("stale", 0),
        "error": groups.get("error", 0), "waiting": groups.get("warming", 0),
        "ready": groups.get("ready", 0)}, "delivery": delivery,
        "runtime_roles": runtime_summary(db, at=stamp),
        "lifecycle": "market-runtime owns the monitor; API downtime does not pause evaluation."}
