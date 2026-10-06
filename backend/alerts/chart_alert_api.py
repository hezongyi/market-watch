"""Authenticated chart-alert HTTP adapter; bounded writes and optimistic edits."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .chart_alert_domain import Contract
from .chart_alert_message import condition_label, signal_message
from .chart_alert_service import (
    AlertConfig,
    Conflict,
    create,
    current_version,
    edit,
    lifecycle,
)
from .storage import ChartAlert, ChartAlertVersion, Notification, Outbox, SignalRow, transaction


class Create(Contract):
    request_id: str = Field(min_length=1, max_length=100)
    config: AlertConfig


class Edit(Contract):
    version: int = Field(ge=1)
    config: AlertConfig


class Action(Contract):
    version: int = Field(ge=1)
    action: Literal["pause", "resume", "restart", "archive", "drawing_deleted"]


def dataset_for(config):
    if config.series_kind == "managed":
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
            "run": alert.run, "status": alert.status, "health": alert.health,
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

    @api.get("")
    def listing(instrument: str | None = None, status: str | None = None, search: str = ""):
        if status and status not in ("active", "paused", "completed", "expired", "archived"):
            raise HTTPException(422, "未知告警状态")
        if len(search) > 100 or instrument and len(instrument) > 40:
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
                return alert_dict(db, lifecycle(db, alert_id, body.version, body.action))
        except (ValueError, LookupError) as exc:
            raise error(exc) from exc

    return api
