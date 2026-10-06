"""Authenticated chart-alert HTTP adapter; bounded writes and optimistic edits."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .chart_alert_domain import Contract
from .chart_alert_geometry import GeometryQuery, geometry
from .chart_alert_message import condition_label, signal_message
from .chart_alert_service import (
    AlertConfig,
    Conflict,
    create,
    current_version,
    edit,
    lifecycle,
)
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeJudgment,
    Instrument,
    Notification,
    Outbox,
    SignalRow,
    transaction,
)


class CapabilityQuery(Contract):
    instrument: str = Field(min_length=1, max_length=64)
    series_kind: Literal["managed", "provider", "composite"]
    timeframe: str


def capabilities(body):
    from .chart_data import FRAMES
    from .provider_capabilities import frames, poll_seconds
    if body.timeframe not in FRAMES:
        raise ValueError("未知判定周期")
    with transaction() as db:
        if body.series_kind == "composite":
            from .series_access import metadata as fixed_metadata

            meta = fixed_metadata(db, body.instrument, "composite")
            return {"instrument": body.instrument, "timeframe": body.timeframe,
                "sources": [{"source": "composite", "series_kind": "composite", "basis": meta["basis"],
                    "calendar": meta["calendar"], "available": body.timeframe in meta["frames"], "reason": None,
                    "observation_basis": "固定历史与确认M1接续；临时触价为显式抽样模式，断线后不追认未观测事件"}],
                "modes": ["close", "intrabar"], "indicators": ["SMA", "EMA", "RSI", "MACD"],
                "line_mapping": "固定组合修订；斜线需要准确周期柱序号", "seam_policies": ["reject", "accept_raw"]}
        instrument = db.get(Instrument, body.instrument)
        managed = ({"source": instrument.source, "series_kind": "managed", "basis": instrument.basis,
                    "calendar": instrument.calendar, "enabled": instrument.enabled}
                   if instrument else None)
    from .provider_chart import metadata
    try:
        native = metadata(body.instrument, cached_only=True)
        provider = {"source": native["source"], "series_kind": "provider", "basis": native["basis"],
                    "calendar": native["calendar"], "enabled": body.timeframe in frames(native["source"])}
    except (HTTPException, ValueError):
        provider = None
    sources = [row for row in (managed, provider) if row]
    for row in sources:
        reason = ("此来源尚未确认告警交易日历" if row["calendar"] not in ("ny17", "utc0")
                  else "来源或周期暂不可用" if not row["enabled"] else None)
        row["available"], row["reason"] = reason is None, reason
        seconds = poll_seconds(row["source"]) if row["series_kind"] == "provider" else 15
        row["observation_basis"] = f"抽样 K 线当前收盘值，约每 {seconds} 秒观察；不重建未观测路径"
    return {"instrument": body.instrument, "timeframe": body.timeframe, "sources": sources,
            "modes": ["close", "intrabar"], "indicators": ["SMA", "EMA", "RSI", "MACD"],
            "relations": ["cross", "cross_up", "cross_down", "above", "below", "enter", "exit", "break_upper", "break_lower"],
            "line_mapping": "必须核对原生 K 线序号和价格轴；未匹配端点时等待数据"}


class Create(Contract):
    request_id: str = Field(min_length=1, max_length=100)
    config: AlertConfig


class Edit(Contract):
    version: int = Field(ge=1)
    config: AlertConfig


class Action(Contract):
    version: int = Field(ge=1)
    control_revision: int = Field(ge=1)
    request_id: str = Field(min_length=1, max_length=100)
    action: Literal["pause", "resume", "restart", "rebaseline", "archive", "drawing_deleted"]


def dataset_for(config):
    if config.series_kind in ("managed", "composite"):
        return None
    from .provider_cache import ensure
    from .provider_chart import metadata
    meta = metadata(config.instrument)
    if meta["source"] != config.source:
        raise ValueError("图表来源已改变，请重新读取图表上下文")
    return ensure(meta, config.timeframe)


def alert_dict(db, alert):
    version = current_version(db, alert)
    return {"id": alert.id, "name": alert.name, "version": alert.version,
            "run": alert.run, "control_revision": alert.control_revision,
            "status": alert.status, "health": alert.health,
            "health_reason": alert.health_reason, "count": alert.count,
            "max_triggers": alert.max_triggers, "effective_at": alert.effective_at,
            "expires_at": alert.expires_at, "created_at": alert.created_at,
            "updated_at": alert.updated_at, "config": version.config,
            "market_identity": version.market_identity,
            "condition_summary": condition_label(version.config["condition"]),
            "runtime": alert.runtime}


def error(exc):
    if isinstance(exc, Conflict):
        return HTTPException(409, str(exc))
    if isinstance(exc, LookupError):
        return HTTPException(404, str(exc))
    return HTTPException(422, str(exc))


def router(authenticated):
    api = APIRouter(prefix="/api/chart-alerts", dependencies=[Depends(authenticated)])

    @api.post("/capabilities")
    def capability(body: CapabilityQuery):
        try:
            return capabilities(body)
        except ValueError as exc:
            raise error(exc) from exc

    @api.post("/geometry")
    def drawing_geometry(body: GeometryQuery):
        try:
            key = dataset_for(body)
            with transaction() as db:
                return geometry(db, body, dataset_id=key)
        except ValueError as exc:
            raise error(exc) from exc

    @api.get("")
    def listing(instrument: str | None = None, status: str | None = None, search: str = ""):
        if status and status not in ("active", "paused", "completed", "expired", "archived"):
            raise HTTPException(422, "未知告警状态")
        if len(search) > 100 or instrument and len(instrument) > 64:
            raise HTTPException(422, "筛选值过长")
        with transaction() as db:
            query = select(ChartAlert).join(ChartAlertVersion, (ChartAlert.id == ChartAlertVersion.alert_id)
                                           & (ChartAlert.version == ChartAlertVersion.version))
            if status:
                query = query.where(ChartAlert.status == status)
            else:
                query = query.where(ChartAlert.status != "archived")
            if search:
                query = query.where(ChartAlert.name.contains(search, autoescape=True))
            if instrument:
                query = query.where(ChartAlertVersion.config["instrument"].as_string() == instrument)
            rows = db.scalars(query.order_by(ChartAlert.created_at.desc()).limit(500))
            result = [alert_dict(db, row) for row in rows]
            return result

    @api.get("/events")
    def events(alert_id: str | None = None, limit: int = 100):
        if not 1 <= limit <= 500 or alert_id and len(alert_id) > 36:
            raise HTTPException(422, "日志请求超出范围")
        with transaction() as db:
            query = select(SignalRow, Notification, Outbox).join(Notification, Notification.signal_id == SignalRow.id).outerjoin(
                Outbox, Outbox.notification_id == Notification.id,
            ).where(SignalRow.chart_alert_id.is_not(None))
            if alert_id:
                query = query.where(SignalRow.chart_alert_id == alert_id)
            return [{"id": record.id, "alert_id": record.chart_alert_id,
                     "occurred_at": record.occurred_at, "detected_at": record.created_at,
                     "direction": record.direction, "price": str(record.price),
                     "threshold": str(record.threshold), "evidence": record.evidence,
                     "message": signal_message(record), "notification_id": notification.id,
                     "notification_status": notification.status, "ack_at": notification.ack_at,
                     "delivery_status": task.status if task else "web_only"}
                    for record, notification, task in db.execute(query.order_by(
                        SignalRow.occurred_at.desc(), SignalRow.created_at.desc()).limit(limit))]

    @api.get("/{alert_id}")
    def read(alert_id: str):
        with transaction() as db:
            alert = db.get(ChartAlert, alert_id)
            if not alert:
                raise HTTPException(404, "告警不存在")
            return alert_dict(db, alert)

    @api.get("/{alert_id}/judgments")
    def judgments(alert_id: str, before: int | None = None, limit: int = 100):
        if len(alert_id) > 36 or not 1 <= limit <= 500 or before is not None and before < 0:
            raise HTTPException(422, "无效判断记录分页")
        with transaction() as db:
            if not db.get(ChartAlert, alert_id):
                raise HTTPException(404, "告警不存在")
            query = select(CompositeJudgment).join(ChartAlertVersion,
                ChartAlertVersion.id == CompositeJudgment.alert_version_id).where(ChartAlertVersion.alert_id == alert_id)
            if before is not None:
                query = query.where(CompositeJudgment.created_at < before)
            return [{"id": row.id, "revision_id": row.revision_id, "history_version_id": row.history_version_id,
                "input_revision": row.input_revision, "event_time": row.event_time, "outcome": row.outcome,
                "signal_id": row.signal_id, "created_at": row.created_at, "evidence": row.evidence}
                for row in db.scalars(query.order_by(CompositeJudgment.created_at.desc(), CompositeJudgment.id).limit(limit))]

    @api.post("", status_code=201)
    def new(body: Create):
        try:
            key = dataset_for(body.config)
            with transaction() as db:
                alert = create(db, body.request_id, body.config, dataset_id=key)
                return alert_dict(db, alert)
        except IntegrityError:
            # Simultaneous retries race on request_id; re-read the winning transaction.
            try:
                with transaction() as db:
                    alert = create(db, body.request_id, body.config, dataset_id=key)
                    return alert_dict(db, alert)
            except ValueError as exc:
                raise error(exc) from exc
        except ValueError as exc:
            raise error(exc) from exc

    @api.post("/{alert_id}/edit")
    def update(alert_id: str, body: Edit):
        try:
            key = dataset_for(body.config)
            with transaction() as db:
                return alert_dict(db, edit(db, alert_id, body.version, body.config, dataset_id=key))
        except (ValueError, LookupError) as exc:
            raise error(exc) from exc

    @api.post("/{alert_id}/lifecycle")
    def action(alert_id: str, body: Action):
        try:
            with transaction() as db:
                return alert_dict(db, lifecycle(db, alert_id, body.version, body.action,
                                               expected_revision=body.control_revision,
                                               request_id=body.request_id))
        except (ValueError, LookupError) as exc:
            raise error(exc) from exc

    return api
