"""Transaction-owned history maintenance commands shared by browser and agents.

Commands queue work or change managed lifecycle state; no supplier I/O or live
demand is created here. The caller owns authorization, idempotency and commit.
"""

from sqlalchemy import select

from .storage import (
    DatasetMaintenance,
    HistoryRun,
    HistoryVersion,
    MarketDataset,
    SourceSeries,
    now_ms,
)


def creation_request(body):
    dataset = dict(body.get("dataset", {}))
    maintenance = dict(body.get("maintenance", {}))
    if dataset.get("catalog_id") is None:
        dataset.pop("catalog_id", None)
    if maintenance.get("expected_configuration_revision") is None:
        maintenance.pop("expected_configuration_revision", None)
    for key, default in (("mode", "base_m1"), ("adjustment", "none"), ("timeframes", None)):
        if dataset.get(key, default) == default:
            dataset.pop(key, None)
    if not maintenance.get("frame_plan"):
        maintenance.pop("frame_plan", None)
    return {**body, "create_only": body.get("create_only", False), "dataset": dataset, "maintenance": maintenance}


class CreationConflict(ValueError):
    def __init__(self, dataset_id):
        self.dataset_id = dataset_id
        super().__init__("此行情已有维护配置，请管理已有行情；本次未覆盖配置。")


def lookup_creation(db, request_id, **identity_fields):
    """Read a scoped durable submission result, without catalog I/O or writes."""
    from .aggregation_policy import history_dataset_identity
    from .data_center import dataset_detail
    from .history_versions import version_report

    if not request_id or len(request_id) > 100:
        raise ValueError("无效的创建提交标识")
    identity = history_dataset_identity(**identity_fields)
    previous = db.scalar(select(HistoryRun).where(HistoryRun.dataset_id == identity.key,
        HistoryRun.request_id == request_id))
    version = db.get(HistoryVersion, previous.version_id) if previous else None
    if not version or not version.manifest.get("maintenance", {}).get("creation_request"):
        return {"found": False}
    return {"found": True, "dataset": dataset_detail(db, identity.key), "task": version_report(db, version.id)}


def create_managed(db, body):
    from .aggregation_policy import history_dataset_identity, register_history_dataset
    from .data_center import dataset_detail
    from .history_api import ManagedRequest
    from .history_maintenance import configure, create_run
    from .history_versions import version_report
    from .source_registry import _insert, collection_identity

    body = ManagedRequest.model_validate(body)
    raw = history_dataset_identity(source=body.dataset.source, provider_symbol=body.dataset.provider_symbol,
        asset_class=body.dataset.asset_class, aggregation_calendar=body.dataset.aggregation_calendar,
        mode=body.dataset.mode, adjustment=body.dataset.adjustment)
    if raw.identity_version == 2:
        from .history_mode_sources import local_details, source_identity, validate_frames

        info, _ = local_details(db, raw.source, raw.provider_symbol)
        selected = validate_frames(raw, info, body.maintenance.timeframes)
        if body.dataset.timeframes is not None and body.dataset.timeframes != selected:
            raise ValueError("创建与维护的周期选择必须一致")
        identity = source_identity(raw, "D1" if raw.mode == "base_d1" else selected[0], info)
    else:
        identity = collection_identity(raw)
    db.execute(_insert(db)(SourceSeries).values(id=identity.key, identity=identity.model_dump())
        .on_conflict_do_nothing(index_elements=["id"]))
    db.scalar(select(SourceSeries).where(SourceSeries.id == identity.key).with_for_update())
    request = creation_request(body.model_dump())
    previous = db.scalar(select(HistoryRun).where(HistoryRun.dataset_id == raw.key,
        HistoryRun.request_id == body.request_id))
    if previous:
        version = db.get(HistoryVersion, previous.version_id)
        original = version.manifest.get("maintenance", {}).get("creation_request", {})
        if creation_request(original) != request:
            raise ValueError("相同提交标识不能更改创建配置")
        return {"dataset": dataset_detail(db, raw.key), "task": version_report(db, version.id)}
    if body.create_only and db.get(DatasetMaintenance, raw.key) is not None:
        raise CreationConflict(raw.key)
    registration = body.dataset.model_dump()
    if raw.identity_version == 2:
        registration["timeframes"] = body.maintenance.timeframes
    row, _ = register_history_dataset(db, **registration)
    configure(db, row.id, **body.maintenance.model_dump())
    version = create_run(db, row.id, request_id=body.request_id)
    version.manifest = {**version.manifest, "maintenance": {
        **version.manifest["maintenance"], "creation_request": request}}
    return {"dataset": dataset_detail(db, row.id), "task": version_report(db, version.id)}


def configure_maintenance(db, dataset_id, body):
    from .history_api import MaintenanceRequest
    from .history_maintenance import configure, plan_report

    body = MaintenanceRequest.model_validate(body)
    configure(db, dataset_id, **body.model_dump())
    return plan_report(db, dataset_id)


def control_maintenance(db, dataset_id, action):
    from .history_api import MaintenanceControl
    from .history_maintenance import plan_report

    MaintenanceControl(action=action)
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    plan = db.get(DatasetMaintenance, dataset_id)
    if not dataset or not plan:
        raise ValueError("维护计划不存在")
    if action in ("pause", "resume"):
        plan.paused = action == "pause"
    else:
        plan.archived = action == "archive"
    plan.updated_at = now_ms()
    return plan_report(db, dataset_id)


def submit_task(db, dataset_id, body):
    from .history_api import RunRequest
    from .history_maintenance import create_run
    from .history_versions import version_report

    body = RunRequest.model_validate(body)
    version = create_run(db, dataset_id, **body.model_dump())
    return version_report(db, version.id)


def control_task(db, version_id, action):
    from .history_api import TaskControl
    from .history_maintenance import task_control
    from .history_versions import version_report

    TaskControl(action=action)
    version = task_control(db, version_id, action)
    return version_report(db, version.id)


def change_aggregation(db, dataset_id, body):
    from .aggregation_policy import change_aggregation as change
    from .history_api import AggregationRequest, dataset_report
    from .history_versions import version_report

    body = AggregationRequest.model_validate(body)
    dataset, inst, version = change(db, dataset_id, body.aggregation_calendar, version_id=body.version_id)
    return {"dataset": dataset_report(dataset, inst), "version": version_report(db, version.id) if version else None}


def request_artifacts(db, version_id, frames):
    from .history_api import ArtifactRequest
    from .history_artifacts import artifact_report
    from .history_artifacts import request_artifacts as request

    ArtifactRequest(timeframes=frames)
    version = db.get(HistoryVersion, version_id)
    if not version:
        raise ValueError("历史版本不存在")
    request(db, version, frames)
    return {"version_id": version_id, "periods": artifact_report(db, version_id)}
