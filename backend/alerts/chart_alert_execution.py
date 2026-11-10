"""Durable price-rule execution transitions, independent of enabled intent."""

from .notification_sources import _append
from .price_alert_reasons import message
from .storage import Audit

FAULT_PHONE_DELAY_MS = 60000
STALL_MS = 60000
PERMANENT = {"realtime_disabled", "binding_unavailable", "binding_changed", "binding_frozen",
    "binding_contract_changed", "confirmation_window_unreadable", "legacy_auto_paused", "unauthorized"}


def transition(db, alert, *, state, now, reason=None, interval=None, checked=True, resolve_incident=False):
    runtime = dict(alert.runtime)
    changed = runtime.get("execution_state") != state or runtime.get("reason_code") != reason
    if checked:
        runtime["last_checked_at"] = now
    if not changed and not (resolve_incident and runtime.get("incident")):
        if interval:
            runtime["last_gap"] = {"reason_code": reason, **interval}
            if interval.get("unrecoverable") and runtime.get("incident"):
                runtime["incident"] = {**runtime["incident"], "immediate": True}
        alert.runtime = runtime
        if runtime.get("incident"):
            phone_due(db, alert, now=now)
        return
    incident = runtime.get("incident")
    context = {"alert_id": alert.id, "version": alert.version, "run": alert.run}
    if state in ("blocked", "recovering"):
        opened = not incident
        if opened:
            number = runtime.get("incident_number", 0) + 1
            runtime["incident_number"] = number
            incident = {"id": f"price:{alert.id}:{alert.version}:{alert.run}:{number}", "opened_at": now, "context": context}
        incident = {**incident, "reason_code": reason}
        runtime["incident"] = incident
        if interval and interval.get("unrecoverable"):
            incident["immediate"] = True
        if opened:
            _append(db.connection(), "task_failure", alert.id, {"source_kind": "chart_alert_execution",
                "dedupe_key": incident["id"], "code": reason, "title": "价格告警执行异常",
                "message": message(reason), "attempt": str(now), "context": context,
                "evidence": interval or {}, "notify_web": True})
    elif incident and (state in ("monitoring", "settled") or resolve_incident):
        _append(db.connection(), "recovery", alert.id,
            {"source_kind": "chart_alert_execution", "dedupe_key": incident["id"]})
        runtime.pop("incident", None)
        runtime["last_incident"] = {**incident, "recovered_at": now}
        if incident.get("phone_notification_id"):
            note = queue_phone(db, alert, incident, now=now, recovery=True)
            runtime["last_incident"]["recovery_notification_id"] = note.id
            runtime["execution_notification"] = pending_phone(note.id)
        elif runtime.get("execution_notification", {}).get("status") == "waiting_delay":
            runtime["execution_notification"] = {"status": "short_fault_web_only",
                "notification_id": None, "device_received": False}
        if runtime.get("last_gap") and not runtime["last_gap"].get("unrecoverable"):
            runtime["last_gap"] = {**runtime["last_gap"], "resolved_at": now}
    if interval:
        runtime["last_gap"] = {"reason_code": reason, **interval}
    runtime.update(execution_state=state, execution_since=now, reason_code=reason)
    alert.runtime = runtime
    alert.health = {"preparing": "warming", "monitoring": "ready", "closed": "ready",
                    "recovering": "stale", "blocked": "blocked", "settling": "ready", "settled": "ready"}[state]
    alert.health_reason = message(reason)
    db.add(Audit(kind="chart_alert_execution", at=now, details={**context,
        "state": state, "reason_code": reason, "interval": interval,
        "incident_id": incident["id"] if incident else None}))
    phone_due(db, alert, now=now)


def end_observation(db, alert, *, now):
    incident = alert.runtime.get("incident")
    if not incident:
        return
    _append(db.connection(), "observation_end", alert.id,
        {"source_kind": "chart_alert_execution", "dedupe_key": incident["id"]})
    runtime = {key: value for key, value in alert.runtime.items() if key != "incident"}
    alert.runtime = {**runtime, "last_incident": {**incident, "ended_at": now}}


def gap(db, alert, *, now, reason, start, end, **evidence):
    interval = {"start": start, "end": end, "bounds": "possible", "unrecoverable": True, **evidence}
    # Every distinct discontinuity is permanent evidence, even inside one outage.
    db.add(Audit(kind="chart_alert_unobserved", at=now, details={"alert_id": alert.id,
        "version": alert.version, "run": alert.run, "reason_code": reason, **interval}))
    transition(db, alert, state="recovering", now=now, reason=reason, interval=interval)
    alert.runtime = {**alert.runtime, "needs_baseline": True}


def queue_phone(db, alert, incident, *, now, recovery=False):
    from .notification_runtime import _queue_system_notice

    title = "价格告警已恢复" if recovery else "价格告警执行异常"
    description = ("执行已恢复，到期结算已结束。" if alert.status == "expired" else
        "当前已恢复监控。") if recovery else message(incident.get("reason_code"))
    gap_info = alert.runtime.get("last_gap")
    if gap_info and gap_info.get("unrecoverable"):
        from .storage import instant

        def label(value):
            return instant(value).isoformat() if value is not None else "边界未知"
        description += f"\n可能受影响区间：{label(gap_info.get('start'))}—{label(gap_info.get('end'))}；未能判定是否触发。"
    return _queue_system_notice(db, title=title, message=f"{alert.name}\n{description}",
        incident_id=incident["id"] + (":recovery" if recovery else ":failure"), at=now,
        context=incident.get("context") or {"alert_id": alert.id, "version": alert.version, "run": alert.run})


def pending_phone(note_id):
    return {"notification_id": note_id, "status": "pending", "device_received": False}


def phone_due(db, alert, *, now):
    from .chart_alert_service import current_version

    runtime = dict(alert.runtime)
    incident = dict(runtime.get("incident") or {})
    if not incident or incident.get("phone_notification_id"):
        return
    if not current_version(db, alert).config.get("notify_ntfy"):
        return
    if (incident.get("immediate") or incident.get("reason_code") in PERMANENT
            or now - incident["opened_at"] >= FAULT_PHONE_DELAY_MS):
        note = queue_phone(db, alert, incident, now=now)
        runtime["incident"] = {**incident, "phone_notification_id": note.id}
        runtime["execution_notification"] = pending_phone(note.id)
    elif runtime.get("execution_notification", {}).get("status") != "waiting_delay":
        runtime["execution_notification"] = {"status": "waiting_delay", "notification_id": None,
            "due_at": incident["opened_at"] + FAULT_PHONE_DELAY_MS, "device_received": False}
    alert.runtime = runtime


def refresh_phone(db, alert, *, now):
    # Only the notifications role has authoritative sending configuration.
    from sqlalchemy import select

    from .config import settings
    from .storage import DeviceReceipt, Notification, Outbox

    if alert.status in ("active", "expired") or alert.runtime.get("demand_hold") == "stale_input":
        phone_due(db, alert, now=now)
    runtime = alert.runtime
    note_id = runtime.get("execution_notification", {}).get("notification_id")
    if not note_id:
        return
    note = db.get(Notification, note_id)
    outbox = db.scalar(select(Outbox).where(Outbox.notification_id == note_id))
    code = None
    status = note.status if note else "unknown"
    if outbox and outbox.status in ("pending", "sending"):
        code = ("phone_topic_missing" if not settings.ntfy_topic.strip() else
                "phone_delivery_disabled" if not settings.delivery_enabled else None)
        if code:
            status = "blocked_configuration"
    if outbox and outbox.status == "blocked":
        code, status = "phone_permission_denied", "delivery_error"
    alert.runtime = {**runtime, "execution_notification": {"notification_id": note_id,
        "status": status, "outbox_status": outbox.status if outbox else None,
        "reason_code": code, "message": message(code),
        "device_received": db.scalar(select(DeviceReceipt.id).where(
            DeviceReceipt.notification_id == note_id).limit(1)) is not None}}


def patrol(db, *, now):
    """Run from notifications health, independently of the evaluator loop."""
    from sqlalchemy import or_, select

    from .chart_alert_service import AlertConfig
    from .price_alert_close import bars, window_reason
    from .price_alert_confirmation import facts
    from .price_alert_inputs import is_price_rule
    from .storage import (
        ChartAlert,
        ChartAlertVersion,
        CompositeAggregateTask,
        CompositeRevision,
        MarketDataset,
        PriceAlertStream,
    )

    rows = db.execute(select(ChartAlert, ChartAlertVersion).join(ChartAlertVersion,
        (ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version))
        .where(or_(ChartAlert.status == "active", ChartAlert.runtime["settlement_pending"].as_boolean(),
            ChartAlert.runtime["execution_notification"]["notification_id"].as_string().is_not(None),
            (ChartAlert.status == "paused") & (ChartAlert.runtime["demand_hold"].as_string() == "stale_input")))
        .order_by(ChartAlert.id).with_for_update(of=ChartAlert, skip_locked=True)).all()
    for alert, version in rows:
        if not is_price_rule(version.config):
            continue
        runtime = dict(alert.runtime)
        if alert.status == "paused" and runtime.get("demand_hold") == "stale_input":
            if not runtime.get("legacy_pause_noticed"):
                alert.runtime = {**runtime, "legacy_pause_noticed": now}
                transition(db, alert, state="blocked", now=now, reason="legacy_auto_paused", checked=False)
            refresh_phone(db, alert, now=now)
            continue
        if alert.status not in ("active", "expired"):
            refresh_phone(db, alert, now=now)
            continue
        reason = None
        config = AlertConfig.model_validate(version.config)
        settling = runtime.get("settlement_pending")
        expired = alert.expires_at is not None and now >= alert.expires_at
        if alert.status == "expired" and not settling:
            refresh_phone(db, alert, now=now)
            continue
        if not runtime.get("taken_over_at") and not expired and now - alert.effective_at >= STALL_MS:
            reason = "worker_not_taken_over"
        elif runtime.get("execution_contract") == "price-v2":
            if config.mode == "intrabar":
                stream = db.get(PriceAlertStream, version.market_identity["target_dataset_id"])
                waiting = bool(stream and stream.sequence > runtime.get("cursor", 0))
                position = runtime.get("cursor", 0)
            else:
                task = db.get(CompositeAggregateTask, (version.market_identity["composite_revision_id"], config.timeframe))
                position = runtime.get("close_cursor", alert.effective_at)
                revision = db.get(CompositeRevision, version.market_identity["composite_revision_id"])
                target = db.get(MarketDataset, version.market_identity["target_dataset_id"])
                candidates = bars(db, revision, config.timeframe, task.applied_input_revision,
                    start=position, end=position + 1) if task and revision and target else []
                waiting = bool(candidates and candidates[0].data["end"] <= now and not window_reason(
                    db, revision, target, task.applied_input_revision, facts(db, target.identity),
                    position, candidates[0].data["end"], row=candidates[0]))
            observation = runtime.get("patrol_progress") or {}
            if observation.get("position") != position or not waiting:
                observation = {"position": position, "since": now}
            elif waiting and now - observation.get("since", now) >= STALL_MS:
                reason = "worker_progress_stalled"
            runtime["patrol_progress"] = observation
            alert.runtime = runtime
            if expired and not settling and alert.status == "active" and now - alert.expires_at >= STALL_MS:
                reason = "worker_progress_stalled"
        alert.runtime = {**alert.runtime, "last_patrolled_at": now}
        if reason:
            transition(db, alert, state="recovering", now=now, reason=reason, checked=False)
        refresh_phone(db, alert, now=now)
