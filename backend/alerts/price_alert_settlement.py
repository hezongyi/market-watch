"""Finite expiry settlement, fenced to the saved rule version/run and inputs."""

from sqlalchemy import func, select

from .chart_alert_execution import transition
from .price_alert_inputs import retention_lock
from .storage import (
    Audit,
    CompositeAggregateTask,
    CompositePreparation,
    MarketDataset,
    PriceAlertInput,
    PriceAlertStream,
)


def pending(alert):
    value = alert.runtime.get("settlement") or {}
    return bool(alert.status == "expired" and alert.runtime.get("execution_contract") == "price-v2"
        and alert.runtime.get("settlement_pending") and value.get("version") == alert.version
        and value.get("run") == alert.run and value.get("effective_at") == alert.effective_at
        and value.get("expires_at") == alert.expires_at)


def runnable(alert):
    return alert.status == "active" or pending(alert)


def begin(db, alert, version, config, *, now):
    if alert.status != "active" or alert.expires_at is None or now < alert.expires_at:
        return
    identity = version.market_identity
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        sorted({identity["dataset_id"], identity["target_dataset_id"]})))
        .order_by(MarketDataset.id).with_for_update()))
    alert.status, alert.control_revision = "expired", alert.control_revision + 1
    if alert.runtime.get("execution_contract") != "price-v2":
        finish(db, alert, now=now, reason="expired_before_price_takeover")
        return
    value = {"version": alert.version, "run": alert.run, "effective_at": alert.effective_at,
        "expires_at": alert.expires_at, "started_at": now, "mode": config.mode,
        "dataset_id": identity["target_dataset_id"], "composite_revision_id": identity["composite_revision_id"]}
    if config.mode == "intrabar":
        retention_lock(db)
        stream = db.get(PriceAlertStream, identity["target_dataset_id"], populate_existing=True)
        last = db.scalar(select(func.max(PriceAlertInput.sequence)).where(
            PriceAlertInput.dataset_id == identity["target_dataset_id"],
            PriceAlertInput.received_at < alert.expires_at))
        value["cursor_limit"] = max(last or 0, alert.runtime.get("cursor", 0),
            stream.trimmed_through if stream else 0)
    else:
        from .composite_series import period
        from .price_alert_confirmation import facts

        task = db.get(CompositeAggregateTask, (identity["composite_revision_id"], config.timeframe))
        prep = db.get(CompositePreparation, identity["composite_revision_id"])
        value.update(input_revision=task.applied_input_revision if task else -1,
            known_input_revision=prep.input_revision if prep else -1,
            query_fact=facts(db, identity["target_identity"]),
            cursor_limit=period(alert.expires_at - 1, config.timeframe, identity["rules"]["aggregation_calendar"])[0])
    alert.runtime = {**alert.runtime, "settlement_pending": True, "settlement": value}
    transition(db, alert, state="settling", now=now)
    db.add(Audit(kind="chart_alert_settlement_started", at=now, details={"alert_id": alert.id,
        **{key: item for key, item in value.items() if key != "query_fact"}}))


def accepts(alert, observation, config):
    if not pending(alert):
        return False
    value = alert.runtime["settlement"]
    evidence = observation.evidence or {}
    if not (alert.effective_at < observation.occurred_at < alert.expires_at
            and observation.sequence <= value["cursor_limit"] and config.mode == value["mode"]):
        return False
    if config.mode == "intrabar":
        return (evidence.get("received_at", alert.expires_at) < alert.expires_at
            and evidence.get("dataset_id") == value["dataset_id"])
    return (evidence.get("input_manifest", {}).get("input_revision") == value["input_revision"]
        and evidence.get("input_manifest", {}).get("composite_revision_id") == value["composite_revision_id"]
        and evidence.get("bar", {}).get("end") == observation.occurred_at)


def finish(db, alert, *, now, reason=None, start=None, end=None):
    value = alert.runtime.get("settlement") or {"version": alert.version, "run": alert.run,
        "effective_at": alert.effective_at, "expires_at": alert.expires_at}
    value = {key: item for key, item in value.items() if key != "query_fact"}
    alert.runtime = {**alert.runtime, "settlement_pending": False,
        "settlement": {**value, "finished_at": now, "outcome": reason or "settled"}}
    if reason:
        db.add(Audit(kind="chart_alert_unobserved", at=now, details={"alert_id": alert.id,
            "version": alert.version, "run": alert.run, "reason_code": reason,
            "start": start if start is not None else alert.effective_at,
            "end": end if end is not None else alert.expires_at, "bounds": "possible"}))
    transition(db, alert, state="blocked" if reason else "settled", now=now, reason=reason)
    db.add(Audit(kind="chart_alert_settlement_finished", at=now, details={"alert_id": alert.id,
        "version": alert.version, "run": alert.run, "outcome": reason or "settled", "count": alert.count}))
