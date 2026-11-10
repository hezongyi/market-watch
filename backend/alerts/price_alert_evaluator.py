"""Fixed-price rules consume committed observations, never a latest-only path."""

from dataclasses import asdict
from decimal import Decimal

from sqlalchemy import select

from .chart_alert_domain import EvaluationState, Observation
from .chart_alert_execution import gap, transition
from .price_alert_inputs import consumers, expire, read_after, register, retention_lock
from .storage import (
    Audit,
    CompositePreparation,
    HistoryVersion,
    MarketDataset,
    PriceAlertStream,
    RealtimeMapping,
)

CONTRACT = "price-v2"


def right_value(config):
    right = config.condition.right
    if not right:
        return None
    return right.value if right.kind == "constant" else right.line.points[0].price


def eligibility(db, revision, *, mode, now, lock=True):
    from .composite_inputs import frozen
    from .composite_quotes import live_snapshot, sampled_observation
    from .history_catalog import account_scope
    from .realtime_switch import revision_enabled

    history = db.get(HistoryVersion, revision.history_version_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id) if mapping else None
    if not history or not target:
        raise ValueError("固定组合来源不存在")
    if lock:
        list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
            sorted({history.dataset_id, target.id}))).order_by(MarketDataset.id).with_for_update()))
    if frozen(db.get(CompositePreparation, revision.id)):
        raise ValueError("组合修订已冻结，请显式编辑绑定")
    if target.identity["account_scope"] != account_scope() or target.identity.get("basis") != "bid":
        raise ValueError("实时映射账户或价格口径不匹配")
    if not revision_enabled(db, revision):
        raise ValueError("该自建品种实时流已关闭，不能启动可执行告警")
    if mode == "intrabar":
        view = live_snapshot(db, revision, now=now)
        sample = sampled_observation(view)
        if (not sample or not view["owned"] or view.get("authentication_hold")
                or view.get("connection_error") in ("unauthorized", "provider_maintenance")
                or view.get("market_session") == "closed"):
            raise ValueError("当前没有有效价格基准，不能启用触价告警")
        return sample


def initialize(db, alert, identity, config, *, now, takeover=False):
    from .storage import CompositeRevision

    revision = db.get(CompositeRevision, identity["composite_revision_id"])
    sample = eligibility(db, revision, mode=config.mode, now=now)
    stream = register(db, identity["target_dataset_id"], now=now)
    if stream.last_received_at is None or not any(
            other.id != alert.id for other, _ in consumers(db, stream.dataset_id, now=now)):
        # A manual resume/new first consumer begins at its current sample. Idle
        # time before that interval must not suppress the first future crossing.
        stream.last_received_at = sample["observed_at"]
        stream.last_mode = "candle_close_sample" if sample["kind"] == "sampled_candle_close" else "stream_quote"
        stream.last_epoch = (sample.get("quote") or sample.get("candle") or {}).get("connection_epoch")
        stream.interrupted = False
    right = right_value(config)
    alert.state = asdict(EvaluationState(sequence=stream.sequence, left=str(sample["value"]),
        right=str(right) if right is not None else None, count=alert.count))
    alert.runtime = {**alert.runtime, "execution_contract": CONTRACT, "cursor": stream.sequence,
        "baseline_mode": "candle_close_sample" if sample["kind"] == "sampled_candle_close" else "stream_quote",
        "baseline_at": now, "last_input_at": sample["observed_at"], "needs_baseline": False}
    transition(db, alert, state="preparing", now=now, reason="awaiting_worker")
    db.add(Audit(kind="chart_alert_baseline", at=now, details={"alert_id": alert.id,
        "version": alert.version, "run": alert.run, "cursor": stream.sequence,
        "price": str(sample["value"]), "threshold": str(right) if right is not None else None,
        "effective_at": alert.effective_at, "takeover": takeover}))


def evaluate_intrabar(db, alert, version, config, now, *, clock=None):
    from .chart_alert_service import consume
    from .composite_alerts import bound_identity
    from .composite_quotes import live_snapshot, sampled_observation
    from .realtime_switch import revision_enabled

    try:
        revision, target = bound_identity(db, version.market_identity)
    except ValueError as exc:
        transition(db, alert, state="blocked", now=now, reason=str(exc))
        return []
    # Same ordering as collectors and registration; do not take Stream first.
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        sorted({version.market_identity["dataset_id"], target.id})))
        .order_by(MarketDataset.id).with_for_update()))
    if clock:
        now = clock()
    if not revision_enabled(db, revision):
        transition(db, alert, state="blocked", now=now, reason="realtime_disabled")
        return []
    if alert.runtime.get("execution_contract") != CONTRACT:
        try:
            initialize(db, alert, version.market_identity, config, now=now, takeover=True)
        except ValueError:
            transition(db, alert, state="recovering", now=now, reason="takeover_waiting_price")
            return []
        gap(db, alert, now=now, reason="upgrade_boundary", start=alert.effective_at, end=now)
        # The just-captured current sample already establishes the new boundary.
        alert.runtime = {**alert.runtime, "needs_baseline": False}
    alert.runtime = {**alert.runtime, "taken_over_at": alert.runtime.get("taken_over_at", now),
        "last_checked_at": now}
    retention_lock(db)
    stream = db.get(PriceAlertStream, target.id, populate_existing=True)
    expire(db, stream, now=now)
    cursor = alert.runtime["cursor"]
    if stream.trimmed_through > cursor:
        gap(db, alert, now=now, reason="input_retention_exceeded",
            start=max(stream.trimmed_start or 0, alert.effective_at, alert.runtime.get("last_input_at", 0)),
            end=stream.trimmed_end, trimmed_through=stream.trimmed_through)
        cursor = stream.trimmed_through
        alert.runtime = {**alert.runtime, "cursor": cursor}
    events = []
    for row in read_after(db, target.id, cursor):
        if alert.status != "active":
            break
        if row.kind == "interruption":
            gap(db, alert, now=now, reason=row.evidence["reason_code"],
                start=row.evidence.get("possible_start"), end=row.evidence.get("end"),
                observation_gap_ms=row.evidence.get("observation_gap_ms"))
        else:
            if row.mode != alert.runtime.get("baseline_mode") and not alert.runtime.get("needs_baseline"):
                gap(db, alert, now=now, reason="observation_mode_changed",
                    start=alert.runtime.get("last_input_at"), end=row.occurred_at)
            recovering = alert.runtime.get("needs_baseline", False)
            record = consume(db, alert.id, Observation(identity=f"price:{target.id}:{row.sequence}",
                sequence=row.sequence, occurred_at=row.occurred_at, left=Decimal(row.price),
                right=right_value(config), market_price=Decimal(row.price), evidence={
                    "dataset_id": target.id, "sequence": row.sequence, "mode": row.mode,
                    "epoch": row.epoch, "received_at": row.received_at, **row.evidence}),
                detected_at=now, baseline=recovering,
                expected_version=alert.version)
            if record:
                events.append(record)
            if recovering:
                db.add(Audit(kind="chart_alert_baseline", at=now, details={"alert_id": alert.id,
                    "version": alert.version, "run": alert.run, "cursor": row.sequence,
                    "price": row.price, "mode": row.mode, "reason": "recovery_baseline"}))
            alert.runtime = {**alert.runtime, "needs_baseline": False, "baseline_mode": row.mode,
                "last_input_at": row.occurred_at, "last_evaluated_at": now,
                "last_outcome": "recovery_baseline" if recovering else "evaluated"}
        alert.runtime = {**alert.runtime, "cursor": row.sequence}
    view = live_snapshot(db, revision, now=now)
    if view.get("market_session") == "closed":
        transition(db, alert, state="closed", now=now)
    elif not view["owned"] or sampled_observation(view) is None:
        transition(db, alert, state="recovering", now=now, reason="price_input_unavailable")
    elif alert.runtime.get("needs_baseline"):
        transition(db, alert, state="recovering", now=now, reason="awaiting_recovery_baseline")
    else:
        transition(db, alert, state="monitoring", now=now)
    return events
