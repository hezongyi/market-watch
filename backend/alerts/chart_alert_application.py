"""ChartAlert application Interface shared by HTTP and MCP.

Adapters own transactions; all writes use the existing lifecycle and event model.
Provider HTTP failures are translated at the provider boundary.
"""

from typing import Literal

from fastapi import HTTPException as ProviderHTTPError
from pydantic import Field
from sqlalchemy import func, select

from .chart_alert_domain import Contract
from .chart_alert_message import condition_label, signal_message
from .chart_alert_service import (
    AlertConfig,
    create,
    current_version,
    edit,
    lifecycle,
)
from .query_errors import QueryError
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeJudgment,
    Instrument,
    NoticeEvent,
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
    from .chart_indicators import public_catalog
    from .provider_capabilities import frames, poll_seconds
    if body.timeframe not in FRAMES:
        raise ValueError("未知判定周期")
    with transaction() as db:
        if body.series_kind == "composite":
            from .series_access import metadata as fixed_metadata

            meta = fixed_metadata(db, body.instrument, "composite")
            return {"instrument": body.instrument, "timeframe": body.timeframe,
                "sources": [{"source": "composite", "series_kind": "composite", "basis": meta["basis"], "atr_frames": meta["frames"],
                    "calendar": meta["calendar"], "available": body.timeframe in meta["frames"], "reason": None,
                    "observation_basis": "固定历史与确认M1接续；临时触价为显式抽样模式，断线后不追认未观测事件"}],
                "modes": ["close", "intrabar"], "indicators": ["SMA", "EMA", "RSI", "MACD", "ROLLING_RANGE_SQUEEZE"],
                "indicator_metadata": {name: meta for name, meta in public_catalog().items() if name in ("SMA", "EMA", "RSI", "MACD", "ROLLING_RANGE_SQUEEZE")},
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
    except (ProviderHTTPError, QueryError, ValueError):
        provider = None
    sources = [row for row in (managed, provider) if row]
    for row in sources:
        row["atr_frames"] = list(frames(row["source"]) if row["series_kind"] == "provider" else FRAMES)
        existing_reason = ("此来源尚未确认告警交易日历" if row["calendar"] not in ("ny17", "utc0")
                          else "来源或周期暂不可用" if not row["enabled"] else None)
        row["available"] = False
        retirement_reason = "旧来源告警已退役，仅支持查看、暂停或归档"
        row["reason"] = (existing_reason + "；" if existing_reason else "") + retirement_reason
        seconds = poll_seconds(row["source"]) if row["series_kind"] == "provider" else 15
        row["observation_basis"] = f"抽样 K 线当前收盘值，约每 {seconds} 秒观察；不重建未观测路径"
    return {"instrument": body.instrument, "timeframe": body.timeframe, "sources": sources,
            "modes": ["close", "intrabar"], "indicators": ["SMA", "EMA", "RSI", "MACD", "ROLLING_RANGE_SQUEEZE"],
            "indicator_metadata": {name: meta for name, meta in public_catalog().items() if name in ("SMA", "EMA", "RSI", "MACD", "ROLLING_RANGE_SQUEEZE")},
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
    if isinstance(config, AlertConfig):
        require_executable_source(config)
    if config.series_kind in ("managed", "composite"):
        return None
    from .provider_cache import ensure
    from .provider_chart import metadata
    try:
        meta = metadata(config.instrument)
    except (ProviderHTTPError, QueryError) as exc:
        raise ValueError(str(exc.detail)) from exc
    if meta["source"] != config.source:
        raise ValueError("图表来源已改变，请重新读取图表上下文")
    if isinstance(config, AlertConfig) and config.condition.offset:
        ensure(meta, config.condition.offset.timeframe)
    return ensure(meta, config.timeframe)


def display_identity(db, config, identity):
    """Readable identity from the saved binding, without resolving a live revision."""
    from .market_names import display_code

    identity = identity or {}
    symbol = identity.get("symbol")
    if not symbol:
        symbol = config["instrument"] if config["series_kind"] != "composite" else "组合行情身份已归档"
    code = display_code(symbol, identity.get("source"))
    return {"code": code, "series_kind": config["series_kind"],
            "basis": identity.get("basis"), "timeframe": config["timeframe"], "source": config["source"]}


def display_label(db, config, identity):
    value = display_identity(db, config, identity)
    kind = {"provider": "平台行情", "managed": "自建行情", "composite": "组合行情"}[value["series_kind"]]
    return " · ".join(str(part) for part in (
        value["code"], kind, value["basis"], value["timeframe"], value["source"].upper()) if part)


def alert_dict(db, alert, *, last_triggered_at=None):
    version = current_version(db, alert)
    return {"id": alert.id, "name": alert.name, "version": alert.version,
            "run": alert.run, "control_revision": alert.control_revision,
            "status": alert.status, "health": alert.health,
            "health_reason": alert.health_reason, "count": alert.count,
            "max_triggers": alert.max_triggers, "effective_at": alert.effective_at,
            "expires_at": alert.expires_at, "created_at": alert.created_at,
            "updated_at": alert.updated_at, "config": version.config,
            "market_identity": version.market_identity,
            "display_identity": display_identity(db, version.config, version.market_identity),
            "last_triggered_at": last_triggered_at,
            "display_label": display_label(db, version.config, version.market_identity),
            "condition_summary": condition_label(version.config["condition"]),
            "runtime": alert.runtime}


def listing(db, instrument: str | None = None, status: str | None = None, search: str = ""):
    if status and status not in ("active", "paused", "completed", "expired", "archived"):
        raise ValueError("未知告警状态")
    if len(search) > 100 or instrument and len(instrument) > 64:
        raise ValueError("筛选值过长")
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
    rows = list(db.scalars(query.order_by(ChartAlert.created_at.desc()).limit(500)))
    last = dict(db.execute(select(SignalRow.chart_alert_id, func.max(SignalRow.occurred_at))
        .where(SignalRow.chart_alert_id.in_([row.id for row in rows]))
        .group_by(SignalRow.chart_alert_id)).all()) if rows else {}
    result = [alert_dict(db, row, last_triggered_at=last.get(row.id)) for row in rows]
    return result

def events(db, alert_id: str | None = None, limit: int = 100):
    if not 1 <= limit <= 500 or alert_id and len(alert_id) > 36:
        raise ValueError("日志请求超出范围")
    query = select(SignalRow, Notification, Outbox).join(Notification, Notification.signal_id == SignalRow.id).outerjoin(
        Outbox, Outbox.notification_id == Notification.id,
    ).where(SignalRow.chart_alert_id.is_not(None))
    if alert_id:
        query = query.where(SignalRow.chart_alert_id == alert_id)
    records = list(db.execute(query.order_by(
        SignalRow.occurred_at.desc(), SignalRow.created_at.desc()).limit(limit)))
    from .notification_center import SUBJECT

    notices = {notice.source_id: notice for notice in db.scalars(select(NoticeEvent).where(
        NoticeEvent.subject == SUBJECT, NoticeEvent.source_domain == "pro_chart",
        NoticeEvent.source_kind == "chart_alert",
        NoticeEvent.source_id.in_([record.id for record, _, _ in records])))} if records else {}
    return [{"id": record.id, "alert_id": record.chart_alert_id,
             "display_identity": display_identity(db, record.evidence["config"], record.evidence.get("market_identity")),
             "display_label": display_label(db, record.evidence["config"], record.evidence.get("market_identity")),
             "notice": ({"id": notice.id, "first_seq": notice.first_seq,
                         "viewed_at": notice.viewed_at, "handled_at": notice.handled_at}
                        if (notice := notices.get(record.id)) else None),
             "occurred_at": record.occurred_at, "detected_at": record.created_at,
             "direction": record.direction, "price": record.evidence.get("price", str(record.price)),
             "threshold": record.evidence.get("threshold", str(record.threshold)), "evidence": record.evidence,
             "message": signal_message(record), "notification_id": notification.id,
             "notification_status": notification.status, "ack_at": notification.ack_at,
             "delivery_status": task.status if task else "web_only"}
            for record, notification, task in records]

def read(db, alert_id: str):
    alert = db.get(ChartAlert, alert_id)
    if not alert:
        raise LookupError("告警不存在")
    return alert_dict(db, alert)

def judgments(db, alert_id: str, before: int | None = None, limit: int = 100):
    if len(alert_id) > 36 or not 1 <= limit <= 500 or before is not None and before < 0:
        raise ValueError("无效判断记录分页")
    if not db.get(ChartAlert, alert_id):
        raise LookupError("告警不存在")
    query = select(CompositeJudgment).join(ChartAlertVersion,
        ChartAlertVersion.id == CompositeJudgment.alert_version_id).where(ChartAlertVersion.alert_id == alert_id)
    if before is not None:
        query = query.where(CompositeJudgment.created_at < before)
    return [{"id": row.id, "revision_id": row.revision_id, "history_version_id": row.history_version_id,
        "input_revision": row.input_revision, "event_time": row.event_time, "outcome": row.outcome,
        "signal_id": row.signal_id, "created_at": row.created_at, "evidence": row.evidence}
        for row in db.scalars(query.order_by(CompositeJudgment.created_at.desc(), CompositeJudgment.id).limit(limit))]

def new(db, body: Create, *, dataset_id=None):
    require_executable_source(body.config)
    existing = db.scalar(select(ChartAlert).where(ChartAlert.request_id == body.request_id))
    if existing is None:
        validate_association(db, body.config)
        validate_geometry(db, body.config, dataset_id=dataset_id)
    return alert_dict(db, create(db, body.request_id, body.config, dataset_id=dataset_id))


def update(db, alert_id: str, body: Edit, *, dataset_id=None):
    require_executable_source(body.config)
    validate_association(db, body.config)
    validate_geometry(db, body.config, dataset_id=dataset_id)
    return alert_dict(db, edit(db, alert_id, body.version, body.config, dataset_id=dataset_id))


def require_executable_source(config):
    if config.series_kind != "composite":
        raise ValueError("新建或编辑的告警必须绑定组合行情；旧来源告警仅可查看、停用或归档")


def action(db, alert_id: str, body: Action):
    alert = db.scalar(select(ChartAlert).where(ChartAlert.id == alert_id).with_for_update())
    if alert:
        config = AlertConfig.model_validate(current_version(db, alert).config)
        if config.series_kind != "composite" and body.action not in ("pause", "archive"):
            raise ValueError("旧来源告警仅可暂停或归档")
    return alert_dict(db, lifecycle(db, alert_id, body.version, body.action,
        expected_revision=body.control_revision, request_id=body.request_id))


def validate_association(db, config):
    """Validate a saved chart locator; unassociated rules need no workspace.

    The native client checkpoints its current layout before creating a bound rule.
    Historical document envelopes and chart UUIDs retain their existing format.
    """
    if config.association is None:
        return
    from .capabilities.drawings import FRAMES, native_state, projection
    from .chart_series import decode
    from .storage import AdvancedWorkspace

    association = config.association
    workspace = db.get(AdvancedWorkspace, association.workspace_id)
    if workspace is None:
        raise ValueError("关联工作区不存在")
    saved = projection(workspace.document)
    if not saved or saved.get("version") != 1:
        raise ValueError("关联工作区尚无已保存的图格，请先保存工作区")
    charts = saved.get("charts", [])
    state = native_state(workspace.document) or {}
    chart_ids = state.get("_mwAlertCharts", [])
    index = association.chart_index
    # Runtime UUID and persisted slot identify the same chart.
    if index is None:
        matches = [row for slot, row in enumerate(charts)
                   if (chart_ids[slot] if slot < len(chart_ids) else str(row.get("chart_id"))) == association.chart_id]
        if len(matches) != 1:
            raise ValueError("关联图格不存在")
        chart = matches[0]
    else:
        if index >= len(charts):
            raise ValueError("关联图格不存在")
        chart = charts[index]
    slot = charts.index(chart)
    if chart_ids and (slot >= len(chart_ids) or association.chart_id != chart_ids[slot]):
        raise ValueError("关联图格身份已改变，请重新读取图格")
    if association.object_kind and (not association.object_id or not association.native_object_id):
        raise ValueError("关联对象身份不完整")
    if association.object_kind == "drawing" and not any(
            str(item.get("id")) == association.native_object_id for item in chart.get("drawings", [])):
        raise ValueError("关联画线不存在，请先保存工作区")
    if association.object_kind == "indicator":
        layouts = state.get("charts", [])
        sources = [source for pane in layouts[slot].get("panes", []) for source in pane.get("sources", [])] if slot < len(layouts) else []
        if not any(str(source.get("id")) == association.native_object_id
                   and str(source.get("type", "")).startswith("Study") for source in sources):
            raise ValueError("关联指标不存在，请先保存工作区")
    instrument, kind = decode(chart["symbol"])
    if (instrument != config.instrument or kind != config.series_kind
            or FRAMES.get(chart["resolution"], chart["resolution"]) != config.timeframe):
        raise ValueError("关联图格与告警行情身份不匹配，请先保存工作区")


def validate_geometry(db, config, *, dataset_id=None):
    """Never trust caller-supplied bar indices, including MCP writes."""
    from .chart_alert_geometry import GeometryQuery, geometry

    for operand in (config.condition.left, config.condition.right):
        if operand is None or operand.kind != "line":
            continue
        line = operand.line
        query = GeometryQuery(instrument=config.instrument, source=config.source,
            series_kind=config.series_kind, timeframe=config.timeframe,
            published=config.published, composite_revision_id=config.composite_revision_id,
            **line.model_dump(mode="json", exclude={"points", "mapping_version"}),
            points=[point.model_dump(mode="json", exclude={"index"}) for point in line.points])
        mapped = geometry(db, query, dataset_id=dataset_id)
        if [point.index for point in line.points] != [point["index"] for point in mapped["points"]]:
            raise ValueError("画线柱序号与行情不匹配，请重新核对端点")
