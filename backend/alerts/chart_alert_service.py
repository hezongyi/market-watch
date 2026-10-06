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
    instrument: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9:_-]+$")
    series_kind: Literal["managed", "provider"] = "managed"
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

    @model_validator(mode="after")
    def frame(self):
        if self.timeframe not in FRAMES:
            raise ValueError("未知判定周期")
        if not self.name.strip():
            raise ValueError("告警名称不能为空")
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
    return hashlib.sha256(json.dumps(config.model_dump(mode="json"), sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def market_identity(db, config: AlertConfig, dataset_id=None):
    """Require the stored source identity; never silently fall back to another series."""
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
    identity = market_identity(db, config, dataset_id)
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
    identity = market_identity(db, config, dataset_id)
    alert.version += 1
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


def lifecycle(db, alert_id, expected_version, action, *, at=None):
    alert = locked(db, alert_id, expected_version)
    at = now_ms() if at is None else at
    if alert.status == "archived":
        if action == "archive":
            return alert
        raise ValueError("已删除的告警不能恢复")
    if action in ("pause", "drawing_deleted"):
        if alert.status == "active":
            alert.status = "paused"
            alert.health_reason = "关联画线已明确删除" if action == "drawing_deleted" else "用户暂停"
    elif action in ("resume", "restart", "rebaseline"):
        if alert.expires_at is not None and alert.expires_at <= at:
            raise ValueError("告警已到期，请先修改到期时间")
        if action == "restart":
            alert.run += 1
            alert.count = 0
        elif alert.count >= alert.max_triggers:
            raise ValueError("已达到次数上限，请明确重新启用")
        elif action == "rebaseline" and alert.health != "blocked":
            raise ValueError("仅等待核对的告警可重建基准")
        elif alert.status == "active" and action != "rebaseline":
            return alert
        alert.status, alert.state, alert.runtime, alert.effective_at = "active", {}, {}, at
        alert.health, alert.health_reason = "warming", "等待重新建立基准"
    elif action == "archive":
        alert.status = "archived"
    else:
        raise ValueError("未知生命周期操作")
    alert.updated_at = at
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
        return None
    version = current_version(db, alert)
    config = AlertConfig.model_validate(version.config)
    state = EvaluationState(**alert.state) if alert.state else EvaluationState(count=alert.count)
    if state.sequence is not None and observation.sequence <= state.sequence:
        return None
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
        raise Conflict("历史事件已存在，运行状态需要重建")
    late = detected_at - observation.occurred_at > 120_000
    record = SignalRow(chart_alert_id=alert.id, event_key=key, instrument_id=config.instrument,
                       occurred_at=observation.occurred_at, created_at=detected_at,
                       direction=trigger.direction,
                       price=observation.market_price if observation.market_price is not None else observation.left,
                       threshold=trigger.threshold, reason=config.name,
                       evidence={"chart_alert": True, "alert_id": alert.id, "rule_version": alert.version,
                                 "run": alert.run, "ordinal": trigger.ordinal,
                                 "observation_id": observation.identity, "left": str(observation.left),
                                 "right": str(observation.right) if observation.right is not None else None,
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
    db.add(Audit(kind="chart_alert_signal", details={"alert_id": alert.id, "signal_id": record.id,
                                                    "ordinal": trigger.ordinal, "run": alert.run}))
    db.flush()
    return record
