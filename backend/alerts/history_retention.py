"""Reference-aware payload reclamation; identities and published manifests survive.

Reclamation and new reference writers lock the same dataset rows. Immutable
payload deletion is only allowed here, after checking references and worker
leases in that transaction. Shared acquisition content is retained while any
history chunk or acquisition cache still points to it.
"""

import re

from sqlalchemy import delete, func, inspect, or_, select

from .storage import (
    AdvancedPreference,
    AdvancedWorkspace,
    Bar,
    ChartAlertVersion,
    ChartHistoryPlan,
    ChartPublication,
    ChartPublicationJob,
    ChartPublishedBar,
    ChartWorkspace,
    CompositeRevision,
    CompositeWatchBinding,
    DatasetMaintenance,
    DatasetReclamation,
    FixedIndicatorBlock,
    FixedIndicatorRun,
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryChunk,
    HistoryReclamation,
    HistoryRun,
    HistoryVersion,
    ImportJob,
    LiveState,
    MarketComposite,
    MarketCoverage,
    MarketDataset,
    MarketDemand,
    RealtimeMapping,
    Replay,
    SignalRow,
    SourceBlob,
    SourceFetch,
    Watch,
    WeeklyHistoryRequest,
    now_ms,
)


def string_values(value):
    if isinstance(value, str):
        yield value
        if value.startswith("MWH:"):
            from .chart_series import decode
            yield decode(value)[0]
    elif isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from string_values(child)
    elif isinstance(value, (tuple, list, set, frozenset)):
        for child in value:
            yield from string_values(child)


def reference_values(row):
    """All durable runtime writers of dataset references, including JSON owners."""
    if isinstance(row, Replay):
        return {"instrument_id": row.instrument_id, "dataset_version": row.dataset_version,
                "input_manifest": row.input_manifest}
    if isinstance(row, RealtimeMapping):
        return {"dataset_id": row.dataset_id, "target_dataset_id": row.target_dataset_id}
    if isinstance(row, MarketComposite):
        return {"dataset_id": row.dataset_id}
    if isinstance(row, CompositeRevision):
        return {"history_version_id": row.history_version_id}
    if isinstance(row, FixedIndicatorRun):
        from sqlalchemy import inspect

        return {"history_version_id": row.history_version_id} if not inspect(row).persistent else None
    if isinstance(row, Watch):
        return {"instrument_id": row.instrument_id, "rule": row.rule}
    if isinstance(row, CompositeWatchBinding):
        return row.market_identity
    if isinstance(row, ChartAlertVersion):
        return {"config": row.config, "market_identity": row.market_identity, "dataset_id": row.dataset_id}
    if isinstance(row, (ChartWorkspace, AdvancedWorkspace)):
        return row.document
    if isinstance(row, AdvancedPreference):
        return row.content
    if isinstance(row, SignalRow):
        return {"instrument_id": row.instrument_id, "evidence": row.evidence}
    if isinstance(row, HistoryVersion):
        return {"dataset_id": row.dataset_id, "manifest": row.manifest}
    if isinstance(row, HistoryRun):
        return {"dataset_id": row.dataset_id, "parent_version_id": row.parent_version_id}
    if isinstance(row, HistoryChunk):
        return {"version_id": row.version_id}
    if isinstance(row, (MarketDemand, ChartHistoryPlan, WeeklyHistoryRequest)):
        return row.instrument_id
    return None


def plan_blocks_reclamation(plan):
    return bool(plan and (plan.realtime_enabled
                         or plan.status not in ("done", "completed", "cancelled")))


def guard_reference_writes(db):
    documents = []
    for row in set(db.new) | set(db.dirty):
        if isinstance(row, ChartHistoryPlan):
            state = inspect(row)
            # Publishing advances an existing plan while owning Instrument.
            # Its unchanged reference is already visible to reclamation; taking
            # Dataset here reverses ingestion's Dataset -> Instrument order.
            # Creation, rebinding and changes to reclamation eligibility still
            # fence against concurrent reclamation with the dataset lock.
            reference_changed = any(state.attrs[key].history.has_changes()
                                    for key in ("instrument_id", "status", "realtime_enabled"))
            if state.persistent and plan_blocks_reclamation(row) and not reference_changed:
                continue
        documents.append(reference_values(row))
    lock_reference_values(db, documents)
    content_ids = sorted({row.content_id for row in db.new if isinstance(row, HistoryChunk) and row.content_id})
    if content_ids:
        found = set(db.scalars(select(SourceBlob.id).where(SourceBlob.id.in_(content_ids))
                               .order_by(SourceBlob.id).with_for_update()))
        if found != set(content_ids):
            raise ValueError("共享来源内容已被回收，请重新获取观测")


def lock_reference_values(db, document):
    """Also called explicitly by optimistic SQL workspace updates."""
    values = set(string_values(document))
    if not values:
        return
    values.update(v[4:] for v in tuple(values) if v.startswith("MWP:"))
    # Bare legacy series never refer to managed history. This also permits
    # predecessor migrations to write legacy watches before history tables exist.
    def declared_refs(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"version_id", "dataset_version", "parent_version_id", "parent_version",
                           "derived_from_version", "history_version_id", "dataset_id", "target_dataset_id", "dataset"} and isinstance(child, str):
                    yield child
                yield from declared_refs(child)
        elif isinstance(value, (tuple, list)):
            for child in value:
                yield from declared_refs(child)

    declared = set(declared_refs(document))
    fixed_ids = {v[4:].lower() for v in values if v.startswith("MWH:")}
    version_ids = {v for v in declared | fixed_ids if re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", v)}
    series_ids = {v for v in values if v.startswith("MD:")}
    series_ids.update(v for v in declared if re.fullmatch(r"[a-f0-9]{64}", v))
    if not version_ids and not series_ids:
        return
    versions = list(db.scalars(select(HistoryVersion).where(HistoryVersion.id.in_(version_ids)))) if version_ids else []
    if fixed_ids and len({row.id for row in versions} & fixed_ids) != len(fixed_ids):
        raise ValueError("所引用固定历史版本不存在")
    dataset_ids = {v.dataset_id for v in versions}
    dataset_ids.update(db.scalars(select(MarketDataset.id).where(
        or_(MarketDataset.id.in_(series_ids), MarketDataset.instrument_id.in_(series_ids)))))
    if not dataset_ids:
        return
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(dataset_ids))
                    .order_by(MarketDataset.id).with_for_update()))
    if versions and db.scalar(select(HistoryReclamation.version_id).where(
            HistoryReclamation.version_id.in_([v.id for v in versions])).limit(1)):
        raise ValueError("所引用历史版本已回收，请选择仍可用的发布版本")


def references(db, dataset_id):
    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("数据集不存在")
    versions = list(db.scalars(select(HistoryVersion.id).where(HistoryVersion.dataset_id == dataset_id)))
    keys = {dataset_id, dataset.instrument_id, *versions}
    refs = []

    def add(kind, ident, detail):
        refs.append({"kind": kind, "id": str(ident), "detail": detail})

    for ident in db.scalars(select(Replay.id).where(or_(Replay.instrument_id == dataset.instrument_id,
                                                       Replay.dataset_version.in_(versions)))):
        add("replay", ident, "固定版本回测")
    for watch in db.scalars(select(Watch).where(Watch.instrument_id == dataset.instrument_id)):
        add("strategy", watch.id, f"策略（{watch.status}）")
    for model, kind, label in ((CompositeWatchBinding, "strategy", "固定组合策略输入"),
                               (ChartAlertVersion, "chart_alert", "预警版本与审计"),
                               (AdvancedPreference, "workspace", "保存的图表自选与偏好"),
                               (ChartWorkspace, "workspace", "保存的图表工作区"),
                               (AdvancedWorkspace, "workspace", "保存的高级工作区"),
                               (SignalRow, "signal", "历史策略事件")):
        for row in db.scalars(select(model).execution_options(yield_per=100)):
            if keys.intersection(string_values(reference_values(row))):
                add(kind, row.watch_id if isinstance(row, CompositeWatchBinding) else row.id, label)
    for version in db.scalars(select(HistoryVersion).where(HistoryVersion.dataset_id != dataset_id)):
        if set(versions).intersection(string_values(version.manifest)):
            add("derivation", version.id, "其他数据集派生版本")
    for run in db.scalars(select(HistoryRun).where(HistoryRun.dataset_id != dataset_id,
                                                 HistoryRun.parent_version_id.in_(versions))):
        add("derivation", run.version_id, "其他任务固定父版本")
    stamp = now_ms()
    for version in db.scalars(select(HistoryVersion).where(HistoryVersion.dataset_id == dataset_id)):
        run = db.get(HistoryRun, version.id)
        if version.lease_until > stamp or version.status not in ("published", "cancelled") or (
                run and run.completed_at is None and run.desired_state != "cancelled"):
            add("task", version.id, "维护或周期派生任务尚未结束")
    for demand in db.scalars(select(MarketDemand).where(MarketDemand.instrument_id == dataset.instrument_id,
                                                       MarketDemand.expires > stamp)):
        add("demand", demand.id, "有效图表使用租约")
    for artifact in db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id.in_(versions),
                                                            HistoryArtifact.status != "published")):
        run = db.get(HistoryRun, artifact.version_id)
        if not run or run.desired_state != "cancelled":
            add("task", artifact.id, "请求的周期产物尚未完成")
    state = db.get(LiveState, dataset_id)
    if state:
        add("live", dataset_id, "该数据集属于实时采集，不能按历史维护回收")
    for model in (ImportJob, WeeklyHistoryRequest):
        for job in db.scalars(select(model).where(model.instrument_id == dataset.instrument_id,
                                                 model.status.notin_(("done", "completed", "cancelled")))):
            add("task", job.id, "图表历史任务")
    plan = db.get(ChartHistoryPlan, dataset.instrument_id)
    if plan_blocks_reclamation(plan):
        add("demand", dataset.instrument_id, "图表持续维护计划")
    # New FK-backed modules (e.g. composites) cannot be accidentally omitted.
    owned = {DatasetMaintenance.__table__.name, DatasetReclamation.__table__.name,
             HistoryVersion.__table__.name, HistoryRun.__table__.name, FixedIndicatorRun.__table__.name,
             "market_history_read_attempts"}
    for table in MarketDataset.metadata.sorted_tables:
        if table.name in owned:
            continue
        for column in table.c:
            targets = {fk.target_fullname for fk in column.foreign_keys}
            if "market_datasets.id" in targets:
                count = db.scalar(select(func.count()).select_from(table).where(column == dataset_id))
                if count and table.name not in ("market_dataset_sources", "market_live_states"):
                    add("dependency", table.name, f"{count} 条数据集依赖")
            if "market_history_versions.id" in targets and table.name != "market_history_reclamations":
                count = db.scalar(select(func.count()).select_from(table).where(column.in_(versions)))
                if count and table.name not in ("market_history_chunks", "market_history_artifacts"):
                    add("dependency", table.name, f"{count} 条固定版本依赖")
    plan = db.get(DatasetMaintenance, dataset_id)
    result = {"dataset_id": dataset_id, "items": refs, "can_reclaim": not refs and bool(plan and plan.archived and plan.paused),
            "requires_archive": not bool(plan and plan.archived and plan.paused),
            "retains": "来源与数据集身份、发布清单和回收记录保留；无引用价格数据物理回收"}
    from .history_reclamation_impact import report

    result["impact"] = report(db, dataset, result)
    return result


class ReclamationConflict(ValueError):
    def __init__(self, report, message):
        self.report = report
        super().__init__(message)


def reclaim(db, dataset_id, request_id, *, expected_review_revision=None):
    if not request_id or len(request_id) > 100:
        raise ValueError("请提供有效回收提交标识")
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    if not dataset:
        raise ValueError("数据集不存在")
    previous = db.scalar(select(DatasetReclamation).where(DatasetReclamation.dataset_id == dataset_id,
                                                         DatasetReclamation.request_id == request_id))
    if previous:
        return previous.summary
    report = references(db, dataset_id)
    if (expected_review_revision is not None and
            expected_review_revision != report["impact"]["review_revision"]):
        raise ReclamationConflict(report, "回收影响或引用已变化，所列数据未删除；请重新查看影响并核对。")
    if report["items"]:
        raise ReclamationConflict(report, "历史仍被引用或有活动任务，请先处理引用；不能回收")
    if report["requires_archive"]:
        raise ReclamationConflict(report, "请先暂停维护并归档，再回收无引用历史")
    versions = list(db.scalars(select(HistoryVersion.id).where(HistoryVersion.dataset_id == dataset_id,
        ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists())))
    artifacts = select(HistoryArtifact.id).where(HistoryArtifact.version_id.in_(versions))
    indicator_runs = select(FixedIndicatorRun.id).where(FixedIndicatorRun.history_version_id.in_(versions))
    candidates = list(db.scalars(select(HistoryChunk.content_id).where(
        HistoryChunk.version_id.in_(versions), HistoryChunk.content_id.is_not(None)).distinct()))
    summary = {"dataset_id": dataset_id, "request_id": request_id, "versions": len(versions), "deleted": {}}
    for model, predicate in (
        (FixedIndicatorBlock, FixedIndicatorBlock.run_id.in_(indicator_runs)),
        (FixedIndicatorRun, FixedIndicatorRun.history_version_id.in_(versions)),
        (HistoryArtifactBlock, HistoryArtifactBlock.artifact_id.in_(artifacts)),
        (HistoryArtifact, HistoryArtifact.version_id.in_(versions)),
        (HistoryChunk, HistoryChunk.version_id.in_(versions)),
        (Bar, Bar.instrument_id == dataset.instrument_id),
        (MarketCoverage, MarketCoverage.instrument_id == dataset.instrument_id),
        (ChartPublishedBar, ChartPublishedBar.instrument_id == dataset.instrument_id),
        (ChartPublicationJob, ChartPublicationJob.instrument_id == dataset.instrument_id),
        (ChartPublication, ChartPublication.instrument_id == dataset.instrument_id),
        (MarketDemand, MarketDemand.instrument_id == dataset.instrument_id),
    ):
        summary["deleted"][model.__tablename__] = db.execute(delete(model).where(predicate)
            .execution_options(synchronize_session=False)).rowcount
    # Lock content candidates in the same order as source-store writers. New
    # references FK/lock them; cached acquisition pointers count as real reachability.
    removed = 0
    for blob_id in db.scalars(select(SourceBlob.id).where(SourceBlob.id.in_(candidates))
                          .order_by(SourceBlob.id).with_for_update()):
        if db.scalar(select(HistoryChunk.id).where(HistoryChunk.content_id == blob_id).limit(1)) or db.scalar(
                select(SourceFetch.id).where(SourceFetch.content_id == blob_id).limit(1)):
            continue
        db.execute(delete(SourceBlob).where(SourceBlob.id == blob_id).execution_options(synchronize_session=False))
        removed += 1
    summary["deleted"][SourceBlob.__tablename__] = removed
    stamp = now_ms()
    for version_id in versions:
        db.add(HistoryReclamation(version_id=version_id, request_id=request_id, reclaimed_at=stamp))
    plan = db.get(DatasetMaintenance, dataset_id)
    plan.latest_version_id, plan.active_version_id = None, None
    plan.updated_at = stamp
    db.add(DatasetReclamation(dataset_id=dataset_id, request_id=request_id, reclaimed_at=stamp, summary=summary))
    db.flush()
    return summary
