"""Transactional chart-alert lifecycle, versions, and independent event delivery.

These functions never fetch market data or send notifications. The worker and
HTTP adapter own the transaction; alert row locks serialize their transitions.
"""

import hashlib
import json
from dataclasses import asdict
from typing import Literal

from pydantic import Field, model_validator
from sqlalchemy import select

from .chart_alert_domain import Condition, Contract, EvaluationState, Observation, advance
from .chart_alert_message import validate_template
from .chart_data import FRAMES
from .chart_indicators import history_requirement
from .provider_capabilities import frames, versions
from .storage import (
    Audit,
    ChartAlert,
    ChartAlertAction,
    ChartAlertVersion,
    Instrument,
    Notification,
    Outbox,
    ProviderDataset,
    SignalRow,
    now_ms,
)


class Association(Contract):
    workspace_id: str = Field(min_length=1, max_length=100)
    chart_id: str = Field(min_length=1, max_length=100)
    generation: str = Field(min_length=1, max_length=100)
    object_id: str | None = Field(default=None, max_length=100)
    object_kind: Literal["drawing", "indicator"] | None = None
    native_object_id: str | None = Field(default=None, max_length=100)
    chart_index: int | None = Field(default=None, ge=0, le=7)


class AlertConfig(Contract):
    name: str = Field(min_length=1, max_length=100)
    instrument: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9:_-]+$")
    series_kind: Literal["managed", "provider", "composite"] = "managed"
    source: str = Field(min_length=1, max_length=32)
    timeframe: str
    mode: Literal["close", "intrabar"] = "close"
    condition: Condition
    max_triggers: Literal[1, 2, 3] = 1
    expires_at: int | None = Field(default=None, gt=0)
    message: str = Field(default="", max_length=2000)
    notify_web: bool = True
    notify_ntfy: bool = False
    late_delivery: Literal["log_only", "notify"] = "log_only"
    association: Association | None = None
    calculation_version: Literal["chart-python-v1"] = "chart-python-v1"
    calculation_origin: int | None = Field(default=None, ge=0)
    published: bool = False
    composite_revision_id: str | None = Field(default=None, max_length=36)
    seam_policy: Literal["reject", "accept_raw"] = "reject"

    @model_validator(mode="after")
    def frame(self):
        if self.timeframe not in FRAMES:
            raise ValueError("未知判定周期")
        if not self.name.strip():
            raise ValueError("告警名称不能为空")
        if self.series_kind != "composite" and (self.composite_revision_id or self.seam_policy != "reject"):
            raise ValueError("组合修订与接缝政策只适用于组合行情")
        if self.series_kind != "composite" and len(self.instrument) > 40:
            raise ValueError("旧系列身份最长40字符")
        if self.series_kind == "composite":
            from .chart_series import decode

            decode("MWC:" + self.instrument)
            if self.source != "composite" or self.published:
                raise ValueError("组合告警必须使用明确组合来源，不使用旧发布系列")
        validate_template(self.message)
        return self

    def indicators(self):
        return [operand.indicator for operand in (self.condition.left, self.condition.right)
                if operand and operand.indicator]

    def warmup(self):
        return max((history_requirement(spec.model_dump()) for spec in self.indicators()), default=0)


class Conflict(ValueError):
    pass


def config_hash(config):
    payload = config.model_dump(mode="json")
    # Preserve pre-offset protocol hashes, including historical request retries.
    if config.condition.offset is None:
        payload["condition"].pop("offset", None)
    return hashlib.sha256(json.dumps(payload, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def bind_offset(db, config, identity, dataset_id):
    spec = config.condition.offset
    if spec is None:
        return identity
    from .chart_alert_offsets import OffsetPending, reference_bar
    from .indicator_state import ALGORITHM
    from .provider_cache import identity as provider_identity
    from .storage import Bar, ChartPublishedBar, ProviderBar

    frame = spec.timeframe
    supported = frames(config.source) if config.series_kind == "provider" else FRAMES
    if frame not in supported:
        raise ValueError("所选来源不支持该 ATR K线周期")
    key, origin = None, None
    if config.series_kind == "provider":
        meta = db.get(ProviderDataset, dataset_id).metadata_json
        key = provider_identity(meta, frame)
        if not db.get(ProviderDataset, key):
            stored_meta = dict(meta)
            if meta["source"] == "oanda":
                from .native_series import parameters, source_identity
                stored_meta["native_period_identity"] = source_identity(meta, parameters(meta), timeframe=frame).model_dump()
            db.add(ProviderDataset(id=key, source=config.source, symbol=meta["symbol"],
                timeframe=frame, metadata_json=stored_meta, coverage=[], earliest=False))
            db.flush()
        origin = db.scalar(select(ProviderBar.start).where(ProviderBar.dataset_id == key)
                           .order_by(ProviderBar.start).limit(1))
    elif config.series_kind == "composite":
        from .composite_series import period
        origin = period(identity["history_start"], frame, identity["calendar"])[0]
    else:
        model = ChartPublishedBar if config.published else Bar
        source_frame = frame if config.published else "M15" if frame == "M30" else "D1" if frame in ("W1", "MN") else frame
        origin = db.scalar(select(model.start).where(model.instrument_id == config.instrument,
            model.timeframe == source_frame).order_by(model.start).limit(1))
        if origin is not None and source_frame != frame:
            from .composite_series import period
            origin = period(origin, frame, identity["calendar"])[0]
        from .publication_schedule import request
        request(db, config.instrument, frames=(frame,))
    if origin is None:
        # Pin a separate scheduled origin. Collection remains subject to source
        # budgets / approved managed history, never the H4 viewport origin.
        cursor = now_ms()
        for _ in range(spec.period * 10 + 1):
            try:
                origin, _ = reference_bar(cursor, frame, identity, config.instrument)
            except OffsetPending:
                origin = 0
                break
            cursor = origin
    return {**identity, "atr_dependency": {"timeframe": frame, "dataset_id": key,
        "origin": origin, "algorithm": ALGORITHM}}


def market_identity(db, config: AlertConfig, dataset_id=None, *, at=None):
    """Require the stored source identity; never silently fall back to another series."""
    if config.series_kind == "composite":
        from .composite_alerts import bind

        if dataset_id:
            raise ValueError("组合告警不能绑定平台缓存数据集")
        return bind(db, config, now=at)
    if config.series_kind == "managed":
        instrument = db.get(Instrument, config.instrument)
        if not instrument or not instrument.enabled or instrument.source != config.source:
            raise ValueError("品种或行情来源已改变，请刷新图表后重试")
        if instrument.calendar not in ("ny17", "utc0"):
            raise ValueError("此来源的告警交易日历尚未确认")
        if dataset_id:
            raise ValueError("自建系列不能使用平台数据集")
        return {"instrument": instrument.id, "series_kind": "managed",
                "source": instrument.source, "symbol": instrument.symbol,
                "basis": instrument.basis, "calendar": instrument.calendar,
                "calendar_profile": instrument.calendar_profile,
                "precision": instrument.precision, "timeframe": config.timeframe,
                "alignment_version": "managed-calendar-v1"}
    dataset = db.get(ProviderDataset, dataset_id) if dataset_id else None
    if not dataset:
        raise ValueError("平台数据集尚未注册")
    meta = dataset.metadata_json
    if meta["calendar"] not in ("ny17", "utc0"):
        raise ValueError("此来源的告警交易日历尚未确认")
    if (dataset.source != config.source or dataset.timeframe != config.timeframe
            or meta["id"] != config.instrument or config.timeframe not in frames(dataset.source)):
        raise ValueError("平台行情身份不匹配")
    return {"instrument": config.instrument, "series_kind": "provider", "dataset_id": dataset.id,
            "source": dataset.source, "symbol": dataset.symbol, "basis": meta["basis"],
            "calendar": meta["calendar"], "precision": meta["precision"],
            "timeframe": dataset.timeframe, "alignment_version": versions(meta)[0],
            **({"native_parameters": meta["native_parameters"]} if meta.get("native_series_id") else {}),
            "adjustment": meta.get("adjustment")}


def current_version(db, alert):
    return db.scalar(select(ChartAlertVersion).where(
        ChartAlertVersion.alert_id == alert.id, ChartAlertVersion.version == alert.version))


def create(db, request_id: str, config: AlertConfig, *, dataset_id=None, at=None):
    digest = config_hash(config)
    existing = db.scalar(select(ChartAlert).where(ChartAlert.request_id == request_id))
    if existing:
        if existing.request_hash != digest:
            raise Conflict("此请求身份已用于其他告警内容")
        return existing
    at = now_ms() if at is None else at
    if config.expires_at is not None and config.expires_at <= at:
        raise ValueError("到期时间必须晚于生效时间")
    identity = bind_offset(db, config, market_identity(db, config, dataset_id, at=at), dataset_id)
    alert = ChartAlert(request_id=request_id, request_hash=digest, name=config.name,
                       effective_at=at, max_triggers=config.max_triggers,
                       expires_at=config.expires_at)
    db.add(alert)
    db.flush()
    db.add(ChartAlertVersion(alert_id=alert.id, version=1, config=config.model_dump(mode="json"),
                             market_identity=identity, dataset_id=dataset_id, effective_at=at))
    db.add(Audit(kind="chart_alert_created", details={"alert_id": alert.id, "version": 1}))
    db.flush()
    return alert


def locked(db, alert_id, expected_version=None):
    alert = db.scalar(select(ChartAlert).where(ChartAlert.id == alert_id).with_for_update())
    if alert is None:
        raise LookupError("告警不存在")
    if expected_version is not None and alert.version != expected_version:
        raise Conflict("告警已被更新，请读取当前版本后重试")
    return alert


def edit(db, alert_id, expected_version, config, *, dataset_id=None, at=None):
    alert = locked(db, alert_id, expected_version)
    if alert.status == "archived":
        raise ValueError("已删除的告警不能编辑")
    at = now_ms() if at is None else at
    if config.expires_at is not None and config.expires_at <= at:
        raise ValueError("到期时间必须晚于生效时间")
    identity = bind_offset(db, config, market_identity(db, config, dataset_id, at=at), dataset_id)
    alert.version += 1
    alert.control_revision += 1
    alert.name, alert.max_triggers, alert.expires_at = config.name, config.max_triggers, config.expires_at
    alert.state, alert.runtime, alert.effective_at, alert.updated_at = {}, {}, at, at
    alert.health, alert.health_reason = "warming", "条件已更新，等待建立新基准"
    if alert.count >= alert.max_triggers:
        alert.status = "completed"
    db.add(ChartAlertVersion(alert_id=alert.id, version=alert.version,
                             config=config.model_dump(mode="json"), market_identity=identity,
                             dataset_id=dataset_id, effective_at=at))
    db.add(Audit(kind="chart_alert_edited", details={"alert_id": alert.id, "version": alert.version}))
    db.flush()
    return alert


def lifecycle(db, alert_id, expected_version, action, *, expected_revision, request_id, at=None):
    alert = locked(db, alert_id)
    digest = hashlib.sha256(json.dumps([expected_version, expected_revision, action]).encode()).hexdigest()
    previous = db.get(ChartAlertAction, (alert_id, request_id))
    if previous:
        if previous.request_hash != digest:
            raise Conflict("此请求身份已用于其他告警操作")
        return alert
    if alert.version != expected_version or alert.control_revision != expected_revision:
        raise Conflict("告警运行状态已改变，请读取当前状态后重试")
    at = now_ms() if at is None else at
    if alert.status == "archived":
        if action != "archive":
            raise ValueError("已删除的告警不能恢复")
    if action in ("pause", "drawing_deleted"):
        if alert.status == "active":
            alert.status = "paused"
            alert.health_reason = "关联画线已明确删除" if action == "drawing_deleted" else "用户暂停"
        alert.runtime = {key: value for key, value in alert.runtime.items() if key != "demand_hold"}
    elif action in ("resume", "restart", "rebaseline"):
        if alert.expires_at is not None and alert.expires_at <= at:
            raise ValueError("告警已到期，请先修改到期时间")
        config = AlertConfig.model_validate(current_version(db, alert).config)
        if config.series_kind == "composite":
            from .composite_alerts import require_live_eligibility
            from .storage import CompositeRevision

            revision = db.get(CompositeRevision, current_version(db, alert).market_identity["composite_revision_id"])
            if not revision:
                raise ValueError("告警绑定的组合修订不存在")
            require_live_eligibility(db, revision, now=at, timeframe=config.timeframe)
        if action == "restart":
            alert.run += 1
            alert.count = 0
        elif alert.count >= alert.max_triggers:
            raise ValueError("已达到次数上限，请明确重新启用")
        elif action == "rebaseline" and alert.health != "blocked":
            raise ValueError("仅等待核对的告警可重建基准")
        elif alert.status == "active" and action != "rebaseline":
            raise ValueError("告警已在监控，无需恢复")
        alert.status, alert.state, alert.runtime, alert.effective_at = "active", {}, {}, at
        alert.health, alert.health_reason = "warming", "等待重新建立基准"
    elif action == "archive":
        alert.status = "archived"
    else:
        raise ValueError("未知生命周期操作")
    alert.updated_at = at
    alert.control_revision += 1
    db.add(ChartAlertAction(alert_id=alert_id, request_id=request_id, request_hash=digest, created_at=at))
    db.add(Audit(kind="chart_alert_" + action, details={"alert_id": alert.id, "run": alert.run}))
    return alert


def consume(db, alert_id, observation: Observation, *, detected_at=None, baseline=False,
            expected_version=None):
    """Checkpoint, count, signal, notification and outbox are one transaction."""
    alert = locked(db, alert_id, expected_version)
    detected_at = now_ms() if detected_at is None else detected_at
    if alert.status != "active":
        return None
    if alert.expires_at is not None and detected_at >= alert.expires_at:
        alert.status = "expired"
        alert.control_revision += 1
        return None
    version = current_version(db, alert)
    config = AlertConfig.model_validate(version.config)
    state = EvaluationState(**alert.state) if alert.state else EvaluationState(count=alert.count)
    if state.sequence is not None and observation.sequence <= state.sequence:
        return None
    if config.condition.offset:
        from .chart_alert_offsets import rebase
        resolved = (observation.evidence or {}).get("offset")
        if not resolved:
            raise ValueError("ATR 告警观察缺少已确认偏移证据")
        runtime = dict(alert.runtime)
        state, translation = rebase(state, runtime.get("offset"), resolved)
        resolved["baseline_translation"] = translation
        runtime["offset"] = dict(resolved)
        alert.runtime = runtime
    # Historical observations are accepted only as an explicit baseline, never as events.
    if observation.occurred_at <= alert.effective_at or baseline:
        alert.state = asdict(EvaluationState(observation.sequence, str(observation.left),
                              str(observation.right) if observation.right is not None else None,
                              alert.count))
        alert.health, alert.health_reason = "ready", None
        return None
    next_state, trigger = advance(config.condition, state, observation, alert.max_triggers)
    alert.state, alert.count = asdict(next_state), next_state.count
    alert.health, alert.health_reason = "ready", None
    if trigger is None:
        return None
    key = hashlib.sha256(json.dumps([alert.id, alert.run, alert.version,
                                    observation.identity, trigger.direction]).encode()).hexdigest()
    # Revisions of the same historical observation never cause another delivery.
    if db.scalar(select(SignalRow.id).where(SignalRow.event_key == key)):
        if config.series_kind != "composite":
            raise Conflict("历史事件已存在，运行状态需要重建")
        # Repaired inputs or a restarted evaluator cannot increment the count
        # again for an already committed logical event.
        alert.count = state.count
        alert.state = asdict(EvaluationState(observation.sequence, str(observation.left),
            str(observation.right) if observation.right is not None else None, state.count))
        return None
    late = detected_at - observation.occurred_at > 120_000
    record = SignalRow(chart_alert_id=alert.id, event_key=key, instrument_id=config.instrument,
                       occurred_at=observation.occurred_at, created_at=detected_at,
                       direction=trigger.direction,
                       price=observation.market_price if observation.market_price is not None else observation.left,
                       threshold=trigger.threshold, reason=config.name,
                       evidence={"chart_alert": True, "alert_id": alert.id, "rule_version": alert.version,
                                 "alert_created_at": alert.created_at,
                                 "run": alert.run, "ordinal": trigger.ordinal,
                                 "observation_id": observation.identity, "left": str(observation.left),
                                 "right": str(observation.right) if observation.right is not None else None,
                                 # The shared legacy signal columns use scale 10.
                                 # Keep exact chart-rule decimals in immutable
                                 # evidence for reloads, logs and notifications.
                                 "price": str(observation.market_price if observation.market_price is not None else observation.left),
                                 "threshold": str(trigger.threshold),
                                 "unit": config.condition.left.unit,
                                 "market_identity": version.market_identity, "config": version.config,
                                 "detected_at": detected_at, "late": late,
                                 "observation": observation.evidence or {}})
    db.add(record)
    db.flush()
    notification = Notification(signal_id=record.id, created_at=detected_at, status=(
        "late_suppressed" if config.notify_ntfy and late and config.late_delivery == "log_only"
        else "pending" if config.notify_ntfy else "web_only"
    ))
    db.add(notification)
    db.flush()
    if config.notify_ntfy:
        db.add(Outbox(notification_id=notification.id, next_at=detected_at,
                      status="suppressed" if late and config.late_delivery == "log_only" else "pending"))
    if alert.count >= alert.max_triggers:
        alert.status = "completed"
        alert.control_revision += 1
    db.add(Audit(kind="chart_alert_signal", details={"alert_id": alert.id, "signal_id": record.id,
                                                    "ordinal": trigger.ordinal, "run": alert.run}))
    db.flush()
    return record
