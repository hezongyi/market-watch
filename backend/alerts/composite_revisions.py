"""Explicit, auditable fixed baseline changes; existing rules keep their inputs.

Preparation pins a finite confirmed input after M1 catch-up, queues period and
indicator work asynchronously, and never switches the active chart revision.
Activation serializes against another activation and records an event boundary.
"""

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import BigInteger, cast, select

from .chart_data import FRAMES
from .composite_definitions import RULES, key
from .history_artifacts import chart_page as history_page
from .history_artifacts import request_artifacts
from .history_catalog import account_scope
from .indicator_state import ALGORITHM
from .source_registry import collection_identity
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeActivation,
    CompositeAggregateTask,
    CompositePreparation,
    CompositeRevision,
    CompositeRevisionChange,
    HistoryArtifact,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
    now_ms,
    transaction,
)


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9:_-]+$")
    expected_revision_id: str = Field(min_length=36, max_length=36)
    history_version_id: str = Field(min_length=36, max_length=36)
    mapping_id: str = Field(min_length=64, max_length=64)
    seam: int = Field(ge=0, multiple_of=60000)
    reason: str = Field(min_length=3, max_length=1000)
    allow_non_day_boundary: bool = False

    @model_validator(mode="after")
    def text(self):
        if len(self.reason.strip()) < 3:
            raise ValueError("请记录本次修订原因")
        return self


class ActivationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9:_-]+$")
    expected_revision_id: str = Field(min_length=36, max_length=36)


def owned(db, composite_id, *, lock=False):
    query = select(MarketComposite).where(MarketComposite.id == composite_id,
        MarketComposite.permission_scope == "workspace:default")
    row = db.scalar(query.with_for_update().execution_options(populate_existing=True) if lock else query)
    if not row:
        raise ValueError("组合不存在或不属于当前权限范围")
    return row


def affected_rules(db, composite_id):
    return [(version, alert) for version, alert in db.execute(select(ChartAlertVersion, ChartAlert).join(
        ChartAlert, (ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "active")) if version.market_identity.get("composite_id") == composite_id]


def create(db, composite_id, body):
    from .composite_series import period

    body = RevisionRequest.model_validate(body)
    # Dataset locks precede the composite lock, matching first_use and source
    # writers; request retry is serialized even when the active revision moved.
    version = db.get(HistoryVersion, body.history_version_id)
    composite = owned(db, composite_id)
    if not version:
        raise ValueError("历史版本不存在")
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        sorted({composite.dataset_id, version.dataset_id}))).order_by(MarketDataset.id).with_for_update()))
    composite = owned(db, composite_id, lock=True)
    request_hash = key(body.model_dump())
    previous = db.scalar(select(CompositeRevision).where(CompositeRevision.composite_id == composite_id,
        CompositeRevision.request_id == body.request_id))
    if previous:
        change = db.get(CompositeRevisionChange, previous.id)
        if not change or change.request_hash != request_hash:
            raise ValueError("修订请求编号已用于不同参数")
        return previous
    if composite.active_revision_id != body.expected_revision_id:
        raise ValueError("启用修订已改变，请刷新后重新比较")
    parent = db.get(CompositeRevision, composite.active_revision_id)
    original = db.get(MarketDataset, composite.dataset_id)
    dataset = db.get(MarketDataset, version.dataset_id)
    if collection_identity(original.identity).key != collection_identity(dataset.identity).key:
        raise ValueError("改日界必须使用同一来源M1的派生版本；不能静默替换历史价格源")
    mapping = db.get(RealtimeMapping, body.mapping_id)
    if not mapping or mapping.dataset_id != dataset.id or mapping.permission_scope != composite.permission_scope:
        raise ValueError("请选择新历史数据集已审核的明确实时映射")
    target = db.get(MarketDataset, mapping.target_dataset_id)
    if target.identity["source"] != "oanda" or target.identity["account_scope"] != account_scope():
        raise ValueError("实时映射须属于当前OANDA账户")
    m1 = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == version.id,
        HistoryArtifact.timeframe == "M1", HistoryArtifact.status == "published", HistoryArtifact.count > 0))
    if version.status != "published" or not m1 or db.get(HistoryReclamation, version.id):
        raise ValueError("请选择已有可用固定M1的已发布历史版本")
    cutoff = (now_ms() - 5000) // 60000 * 60000
    newest = history_page(db, version.id, "M1", count=1)["bars"][-1]
    if not version.start < body.seam <= min(version.end, newest["end"], cutoff):
        raise ValueError("拼接点必须在有效历史基线内且不超过准备截止")
    calendar = db.get(Instrument, dataset.instrument_id).calendar
    if not body.allow_non_day_boundary and period(body.seam, "D1", calendar)[0] != body.seam:
        raise ValueError("拼接点不是所选日界；非日界需明确声明新接续规则")
    rules = {**RULES, "aggregation_calendar": calendar,
        "historical_calendar_version": dataset.identity["calendar_version"]}
    if body.allow_non_day_boundary:
        rules["seam"] = "explicit-minute-boundary-v1"
    if (parent.history_version_id, parent.mapping_id, parent.seam, parent.rules) == (
            version.id, mapping.id, body.seam, rules):
        raise ValueError("本次修订没有改变基线、映射、拼接点或规则")
    revision = CompositeRevision(composite_id=composite.id, history_version_id=version.id,
        mapping_id=mapping.id, parent_revision_id=parent.id, seam=body.seam, rules=rules, request_id=body.request_id)
    db.add(revision)
    db.flush()

    warmups, impacted = {}, []
    for saved, alert in affected_rules(db, composite.id):
        impacted.append({"id": alert.id, "name": alert.name, "rule_version": alert.version,
            "revision_id": saved.market_identity["composite_revision_id"], "migration": "keeps_fixed_revision"})
        from .chart_alert_service import AlertConfig

        config = AlertConfig.model_validate(saved.config)
        for indicator in config.indicators():
            spec = indicator.model_dump(exclude={"output"})
            warmups[key([config.timeframe, spec])] = {"timeframe": config.timeframe, "spec": spec}
    db.add(CompositeRevisionChange(revision_id=revision.id, request_hash=request_hash, reason=body.reason,
        manifest={"request": body.model_dump(), "cutoff": cutoff, "history_checksum": version.manifest["checksum"],
            "warmups": list(warmups.values()), "affected_rules": impacted, "indicator_algorithm": ALGORITHM,
            "policy": "no_implicit_rule_migration"}))
    db.add(CompositePreparation(revision_id=revision.id, cursor=body.seam, cutoff=cutoff,
        state={"stage": "confirm_recent_m1", "target_identity": target.identity,
            "historical_input": {"version_id": version.id, "checksum": version.manifest["checksum"],
                "start": version.start, "end": body.seam}}))
    request_artifacts(db, version, FRAMES)
    from .composite_aggregates import request

    request(db, revision.id)
    db.flush()
    return revision


def readiness(db, revision, *, enqueue=False):
    from .fixed_indicators import request

    prep = db.get(CompositePreparation, revision.id)
    change = db.get(CompositeRevisionChange, revision.id)
    if change and change.manifest.get("indicator_algorithm") != ALGORITHM:
        if enqueue:
            prep.state = {**prep.state, "activation_checked_at": now_ms(), "activation_ready": False}
        return {"ready": False, "status": "algorithm_changed", "input_revision": None,
            "cutoff": prep.cutoff, "periods_ready": False, "indicators": [],
            "query_error": "指标算法已改变，请重新建立修订", "coverage": "unverified"}
    value = prep.state.get("activation_input_revision") if change else prep.input_revision
    status = "confirming_m1" if prep.status != "queried" or prep.error else "publishing_periods"
    if value is None and prep.status == "queried" and not prep.error and enqueue:
        value = prep.input_revision
        prep.state = {**prep.state, "activation_input_revision": value}
    periods = list(db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id == revision.history_version_id)))
    tasks = {task.timeframe: task for task in db.scalars(select(CompositeAggregateTask).where(
        CompositeAggregateTask.revision_id == revision.id))}
    periods_ready = set(FRAMES) <= {item.timeframe for item in periods if item.status == "published"} and (
        value is not None and all(frame in tasks and tasks[frame].applied_input_revision >= value for frame in FRAMES))
    indicators, complete = [], True
    if prep.status == "queried" and not prep.error and periods_ready:
        status = "initializing_indicators"
        for warmup in change.manifest["warmups"] if change else []:
            page = {"revision_id": revision.id, "history_version_id": revision.history_version_id,
                "input_revision": value, "timeframe": warmup["timeframe"]}
            # Progress reads must never queue work. The asynchronous worker owns
            # the immutable warmup input and stores exact run references.
            stored = prep.state.get("activation_indicators", {}).get(key(warmup))
            from .storage import FixedIndicatorRun

            run = request(db, page, warmup["spec"], stamp=prep.cutoff) if enqueue else db.get(FixedIndicatorRun, stored) if stored else None
            if run and enqueue:
                prep.state = {**prep.state, "activation_indicators": {
                    **prep.state.get("activation_indicators", {}), key(warmup): run.id}}
            indicators.append({**warmup, "run_id": run.id if run else None,
                "status": run.status if run else "pending", "cursor": run.cursor if run else None,
                "target_end": run.target_end if run else None})
            complete &= bool(run and run.status == "complete")
        if complete:
            status = "ready"
    if enqueue:
        prep.state = {**prep.state, "activation_ready": status == "ready", "activation_checked_at": now_ms()}
    return {"ready": status == "ready", "status": status, "input_revision": value,
        "cutoff": prep.cutoff, "periods_ready": periods_ready, "indicators": indicators,
        "query_error": prep.error, "coverage": "per-bar; readiness does not certify all historical coverage"}


def report(db, composite_id, revision_id):
    owned(db, composite_id)
    revision = db.get(CompositeRevision, revision_id)
    if not revision or revision.composite_id != composite_id:
        raise ValueError("修订不属于当前组合")
    change = db.get(CompositeRevisionChange, revision.id)
    activation = db.get(CompositeActivation, revision.id)
    version = db.get(HistoryVersion, revision.history_version_id)
    return {"id": revision.id, "request_id": revision.request_id, "parent_revision_id": revision.parent_revision_id,
        "history_version_id": version.id, "dataset_id": version.dataset_id,
        "history_checksum": version.manifest["checksum"], "mapping_id": revision.mapping_id,
        "seam": revision.seam, "rules": revision.rules, "created_at": revision.created_at,
        "reason": change.reason if change else "首次实际使用", "change": change.manifest if change else None,
        "preparation": readiness(db, revision), "activated_at": revision.activated_at,
        "activation": {"at": activation.at, "previous_revision_id": activation.previous_revision_id,
            "input_revision": activation.input_revision, "event_boundary": activation.event_boundary} if activation else None}


def options(db, composite_id):
    from .composite_series import period

    composite = owned(db, composite_id)
    original = db.get(MarketDataset, composite.dataset_id)
    source = collection_identity(original.identity).key
    output = []
    for version, dataset in db.execute(select(HistoryVersion, MarketDataset).join(
        MarketDataset, HistoryVersion.dataset_id == MarketDataset.id).where(HistoryVersion.status == "published",
            ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists()
        ).order_by(HistoryVersion.published_at.desc(), HistoryVersion.id)):
        if collection_identity(dataset.identity).key != source:
            continue
        artifact = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == version.id,
            HistoryArtifact.timeframe == "M1", HistoryArtifact.status == "published", HistoryArtifact.count > 0))
        if not artifact:
            continue
        inst = db.get(Instrument, dataset.instrument_id)
        end = min(version.end, history_page(db, version.id, "M1", count=1)["bars"][-1]["end"])
        seam = period(end, "D1", inst.calendar)[0]
        mappings = []
        for mapping in db.scalars(select(RealtimeMapping).where(RealtimeMapping.dataset_id == dataset.id,
                RealtimeMapping.permission_scope == composite.permission_scope)):
            target = db.get(MarketDataset, mapping.target_dataset_id)
            if target.identity["account_scope"] == account_scope():
                from .market_names import display_code
                mappings.append({"id": mapping.id, "provider_symbol": target.identity["provider_symbol"],
                    "display_symbol": display_code(target.identity["provider_symbol"], target.identity["source"], target.asset_class),
                    "environment": target.identity["environment"], "reviewed": mapping.match.get("reviewed", False)})
        output.append({"version_id": version.id, "dataset_id": dataset.id, "calendar": inst.calendar,
            "start": version.start, "end": version.end, "checksum": version.manifest["checksum"],
            "recommended_seam": seam if seam > version.start else None, "mappings": mappings})
    return {"active_revision_id": composite.active_revision_id, "items": output}


def activate(db, composite_id, revision_id, body):
    body = ActivationRequest.model_validate(body)
    composite = owned(db, composite_id, lock=True)
    revision = db.get(CompositeRevision, revision_id)
    if not revision or revision.composite_id != composite.id or not db.get(CompositeRevisionChange, revision.id):
        raise ValueError("请选择本组合显式准备的新修订")
    existing = db.get(CompositeActivation, revision.id)
    if existing:
        if existing.request_id != body.request_id or existing.previous_revision_id != body.expected_revision_id:
            raise ValueError("修订已经通过其他请求启用")
        return existing
    if composite.active_revision_id != body.expected_revision_id or revision.parent_revision_id != body.expected_revision_id:
        raise ValueError("启用修订已改变，禁止覆盖并发切换；请重新建立修订")
    db.scalar(select(CompositePreparation).where(CompositePreparation.revision_id == revision.id).with_for_update())
    progress = readiness(db, revision)
    if not progress["ready"]:
        raise ValueError("新修订尚未完成固定M1、周期和指标准备")
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    if db.get(MarketDataset, mapping.target_dataset_id).identity["account_scope"] != account_scope():
        raise ValueError("实时账户已改变，不能启用旧映射")
    stamp = now_ms()

    activation = CompositeActivation(revision_id=revision.id, previous_revision_id=composite.active_revision_id,
        request_id=body.request_id, input_revision=progress["input_revision"], event_boundary=stamp // 60000 * 60000,
        at=stamp, evidence={"preparation": progress, "affected_rules": [
            {"id": alert.id, "revision_id": saved.market_identity["composite_revision_id"],
                "migration": "keeps_fixed_revision"} for saved, alert in affected_rules(db, composite.id)]})
    db.add(activation)
    composite.active_revision_id, revision.activated_at = revision.id, stamp
    db.flush()
    return activation


def preparation_tick():
    # Poll at most 20 pending explicit revisions. No supplier I/O in this phase;
    # M1 and indicator workers own their own leases and immutable checkpoints.
    with transaction() as db:
        from sqlalchemy import or_

        revisions = list(db.scalars(select(CompositeRevision.id).join(CompositeRevisionChange).join(
            CompositePreparation, CompositePreparation.revision_id == CompositeRevision.id).where(
            CompositeRevision.activated_at.is_(None), or_(
                CompositePreparation.state["activation_ready"].as_boolean().is_(None),
                CompositePreparation.state["activation_ready"].as_boolean().is_(False))
        ).order_by(cast(CompositePreparation.state["activation_checked_at"].as_string(), BigInteger).asc().nullsfirst(),
            CompositeRevision.created_at).limit(20)))
    for ident in revisions:
        with transaction() as db:
            revision = db.get(CompositeRevision, ident)
            version = db.get(HistoryVersion, revision.history_version_id)
            db.scalar(select(MarketDataset.id).where(MarketDataset.id == version.dataset_id).with_for_update())
            db.scalar(select(CompositePreparation).where(CompositePreparation.revision_id == revision.id)
                .with_for_update())
            readiness(db, revision, enqueue=True)
    return bool(revisions)
