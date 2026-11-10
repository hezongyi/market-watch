"""Durable price-rule execution transitions, independent of enabled intent."""

from .notification_sources import _append
from .storage import Audit


def transition(db, alert, *, state, now, reason=None, interval=None):
    runtime = dict(alert.runtime)
    changed = runtime.get("execution_state") != state or runtime.get("reason_code") != reason
    runtime["last_checked_at"] = now
    if not changed:
        alert.runtime = runtime
        return
    incident = runtime.get("incident")
    context = {"alert_id": alert.id, "version": alert.version, "run": alert.run}
    if state in ("blocked", "recovering"):
        if not incident:
            number = runtime.get("incident_number", 0) + 1
            runtime["incident_number"] = number
            incident = {"id": f"price:{alert.id}:{alert.version}:{alert.run}:{number}", "opened_at": now}
        incident = {**incident, "reason_code": reason}
        runtime["incident"] = incident
        _append(db.connection(), "task_failure", alert.id, {"source_kind": "chart_alert",
            "dedupe_key": incident["id"], "code": reason, "title": "价格告警执行异常",
            "attempt": str(now), "context": context, "evidence": interval or {}})
    elif incident and state in ("monitoring", "closed"):
        _append(db.connection(), "recovery", alert.id,
            {"source_kind": "chart_alert", "dedupe_key": incident["id"]})
        runtime.pop("incident", None)
    if interval:
        runtime["last_gap"] = {"reason_code": reason, **interval}
    runtime.update(execution_state=state, execution_since=now, reason_code=reason)
    alert.runtime = runtime
    alert.health = {"preparing": "warming", "monitoring": "ready", "closed": "ready",
                    "recovering": "stale", "blocked": "blocked"}[state]
    alert.health_reason = reason
    db.add(Audit(kind="chart_alert_execution", at=now, details={**context,
        "state": state, "reason_code": reason, "interval": interval,
        "incident_id": incident["id"] if incident else None}))


def gap(db, alert, *, now, reason, start, end, **evidence):
    interval = {"start": start, "end": end, "bounds": "possible", **evidence}
    # Every distinct discontinuity is permanent evidence, even inside one outage.
    db.add(Audit(kind="chart_alert_unobserved", at=now, details={"alert_id": alert.id,
        "version": alert.version, "run": alert.run, "reason_code": reason, **interval}))
    transition(db, alert, state="recovering", now=now, reason=reason, interval=interval)
    alert.runtime = {**alert.runtime, "needs_baseline": True}
