"""Authenticated source identities, import controls and immutable version reports."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from .aggregation_policy import (
    DEFAULTS,
    AggregationCalendar,
    AssetClass,
    change_aggregation,
    register_history_dataset,
)
from .history_versions import create_version, version_report
from .market_datasets import legacy_inventory
from .storage import (
    DatasetMaintenance,
    HistoryVersion,
    Instrument,
    MarketDataset,
    now_ms,
    transaction,
)


class VersionRequest(BaseModel):
    dataset_id: str = Field(min_length=64, max_length=64)
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class DatasetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["dukascopy", "oanda"] = "dukascopy"
    logical_symbol: str = Field(pattern=r"^[A-Z0-9]{1,10}$")
    provider_symbol: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9/_.-]+$")
    asset_class: AssetClass
    precision: int = Field(ge=0, le=10, strict=True)
    aggregation_calendar: AggregationCalendar | None = None
    catalog_id: str | None = Field(default=None, max_length=64)


class AggregationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aggregation_calendar: AggregationCalendar
    version_id: str | None = Field(default=None, min_length=1, max_length=36)


class MaintenanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_start: int = Field(ge=0, strict=True)
    timeframes: list[str] = Field(min_length=1, max_length=9)
    frequency: Literal["daily", "once"] = "daily"
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    daily_minute: int = Field(default=15, ge=0, lt=1440, strict=True)
    overlap_minutes: int = Field(default=2880, ge=0, le=44640, strict=True)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100)
    kind: Literal["update", "backfill", "recheck"] = "update"
    start: int | None = Field(default=None, ge=0, strict=True)
    end: int | None = Field(default=None, gt=0, strict=True)


class MaintenanceControl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["pause", "resume", "archive", "unarchive"]


class TaskControl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["pause", "resume", "retry", "cancel"]


class ArtifactRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timeframes: list[str] = Field(min_length=1, max_length=9)


class ReclamationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100)


class ManagedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset: DatasetRequest
    maintenance: MaintenanceRequest
    request_id: str = Field(min_length=1, max_length=100)


def _creation_request(body):
    # Old manifests predate optional catalogue selection. Missing and null mean
    # the same manual request; preserve every other field in retry comparison.
    dataset = dict(body.get("dataset", {}))
    if dataset.get("catalog_id") is None:
        dataset.pop("catalog_id", None)
    return {**body, "dataset": dataset}


def dataset_report(row, inst):
    return {"id": row.id, "instrument_id": row.instrument_id,
            "logical_symbol": row.logical_symbol, "identity": row.identity,
            "volume_kind": row.volume_kind, "volume_unit": row.volume_unit,
            "precision": inst.precision, "asset_class": row.asset_class,
            "aggregation_calendar": inst.calendar}


def router(authenticated):
    routes = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @routes.get("/datasets")
    def datasets():
        with transaction() as db:
            return [dataset_report(row, db.get(Instrument, row.instrument_id))
                    for row in db.scalars(select(MarketDataset).order_by(MarketDataset.logical_symbol))]

    @routes.get("/center/datasets")
    def center_datasets(query: str = "", source: str | None = None, calendar: str | None = None,
                        asset_class: str | None = None, status: str = "all", page: int = 1, page_size: int = 25):
        from .data_center import dataset_list

        try:
            with transaction() as db:
                return dataset_list(db, query=query, source=source, calendar=calendar,
                    asset_class=asset_class, status=status, page=page, page_size=page_size)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/center/tasks")
    def center_tasks(dataset_id: str | None = None, page: int = 1, page_size: int = 25):
        from .data_center import task_list

        try:
            with transaction() as db:
                return task_list(db, dataset_id=dataset_id, page=page, page_size=page_size)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/center/platform")
    def center_platform(query: str = "", source: str | None = None, page: int = 1, page_size: int = 25):
        from sqlalchemy import func, or_

        from .source_registry import capabilities
        from .storage import MarketCatalog

        if page < 1 or not 1 <= page_size <= 100:
            raise HTTPException(422, "无效的目录分页")
        with transaction() as db:
            rows = select(MarketCatalog).where(~MarketCatalog.id.startswith("HC:"))
            if query:
                rows = rows.where(or_(MarketCatalog.symbol.contains(query[:100], autoescape=True),
                                      MarketCatalog.label.contains(query[:100], autoescape=True)))
            if source:
                rows = rows.where(MarketCatalog.source == source)
            total = db.scalar(select(func.count()).select_from(rows.subquery()))
            items = [{"id": r.id, "source": r.source, "provider_symbol": r.symbol,
                "label": r.label, "asset_class": r.asset_type, "precision": r.precision,
                "available": r.available, "updated_at": r.updated_at,
                "capabilities": capabilities(r.source)} for r in db.scalars(rows.order_by(
                    MarketCatalog.symbol, MarketCatalog.source, MarketCatalog.id)
                    .offset((page - 1) * page_size).limit(page_size))]
            return {"items": items, "total": total, "page": page, "page_size": page_size}

    @routes.get("/center/datasets/{dataset_id}")
    def center_detail(dataset_id: str):
        from .data_center import dataset_detail

        try:
            with transaction() as db:
                return dataset_detail(db, dataset_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None

    @routes.get("/datasets/{dataset_id}/references")
    def dataset_references(dataset_id: str):
        from .history_retention import references

        try:
            with transaction() as db:
                return references(db, dataset_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None

    @routes.post("/datasets/{dataset_id}/reclaim")
    def reclaim_history(dataset_id: str, body: ReclamationRequest):
        from .history_retention import reclaim

        try:
            with transaction() as db:
                return reclaim(db, dataset_id, body.request_id)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @routes.post("/center/datasets", status_code=201)
    def create_managed(body: ManagedRequest):
        from .data_center import dataset_detail
        from .history_maintenance import configure, create_run
        from .source_registry import collection_identity

        try:
            with transaction() as db:
                # Acquire a source-level registration lock before any instrument
                # insert. It serializes concurrent first registration as well.
                from .aggregation_policy import history_dataset_identity
                from .source_registry import _insert
                from .storage import SourceSeries

                raw = history_dataset_identity(source=body.dataset.source,
                    provider_symbol=body.dataset.provider_symbol, asset_class=body.dataset.asset_class,
                    aggregation_calendar=body.dataset.aggregation_calendar)
                identity = collection_identity(raw)
                db.execute(_insert(db)(SourceSeries).values(id=identity.key, identity=identity.model_dump())
                    .on_conflict_do_nothing(index_elements=["id"]))
                db.scalar(select(SourceSeries).where(SourceSeries.id == identity.key).with_for_update())
                from .storage import HistoryRun

                request = _creation_request(body.model_dump())
                previous = db.scalar(select(HistoryRun).where(HistoryRun.dataset_id == raw.key,
                    HistoryRun.request_id == body.request_id))
                if previous:
                    version = db.get(HistoryVersion, previous.version_id)
                    original = version.manifest.get("maintenance", {}).get("creation_request", {})
                    if _creation_request(original) != request:
                        raise ValueError("相同提交标识不能更改创建配置")
                    return {"dataset": dataset_detail(db, raw.key), "task": version_report(db, version.id)}
                row, _ = register_history_dataset(db, **body.dataset.model_dump())
                configure(db, row.id, **body.maintenance.model_dump())
                version = create_run(db, row.id, request_id=body.request_id)
                version.manifest = {**version.manifest, "maintenance": {
                    **version.manifest["maintenance"], "creation_request": request}}
                return {"dataset": dataset_detail(db, row.id), "task": version_report(db, version.id)}
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/sources")
    def sources():
        from .source_registry import capabilities

        return [capabilities(source) for source in ("dukascopy", "oanda", "binance", "yahoo")]

    @routes.get("/history-catalog")
    def history_catalog(source: str, query: str = "", page: int = 1, page_size: int = 25):
        from .history_catalog import catalog

        try:
            with transaction() as db:
                return catalog(db, source=source, query=query, page=page, page_size=page_size)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/versions/{version_id}/requests")
    def history_requests(version_id: str, page: int = 1, page_size: int = 25):
        from .history_request_evidence import report

        try:
            with transaction() as db:
                return report(db, version_id, page=page, page_size=page_size)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/history-catalog/refresh")
    def refresh_history_catalog():
        from .history_catalog import refresh_oanda

        try:
            return refresh_oanda()
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        except Exception:
            raise HTTPException(502, "OANDA来源目录刷新失败；原目录保留，请检查连接") from None

    @routes.get("/datasets/{dataset_id}/source")
    def collection(dataset_id: str):
        from .source_registry import source_report

        with transaction() as db:
            try:
                return source_report(db, dataset_id)
            except ValueError as error:
                raise HTTPException(404, str(error)) from None

    @routes.get("/aggregation-options")
    def options():
        return {"defaults": DEFAULTS, "calendars": ["ny17", "utc0"],
                "unresolved_asset_classes": ["index", "other", "unspecified"]}

    @routes.get("/date-boundary")
    def date_boundary(date: str, calendar: AggregationCalendar):
        from types import SimpleNamespace

        from .managed_dataset import date_start

        try:
            return {"start": date_start(SimpleNamespace(calendar=calendar), date), "calendar": calendar}
        except ValueError:
            raise HTTPException(422, "无效的交易日期") from None

    @routes.get("/datasets/{dataset_id}/maintenance")
    def maintenance(dataset_id: str):
        from .history_maintenance import plan_report

        with transaction() as db:
            if not db.get(MarketDataset, dataset_id):
                raise HTTPException(404, "数据集不存在")
            return plan_report(db, dataset_id)

    @routes.post("/datasets/{dataset_id}/maintenance")
    def configure_maintenance(dataset_id: str, body: MaintenanceRequest):
        from .history_maintenance import configure, plan_report

        try:
            with transaction() as db:
                configure(db, dataset_id, **body.model_dump())
                return plan_report(db, dataset_id)
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/datasets/{dataset_id}/maintenance/control")
    def control_maintenance(dataset_id: str, body: MaintenanceControl):
        from .history_maintenance import plan_report

        with transaction() as db:
            db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
            plan = db.get(DatasetMaintenance, dataset_id)
            if not plan:
                raise HTTPException(404, "维护计划不存在")
            if body.action in ("pause", "resume"):
                plan.paused = body.action == "pause"
            else:
                plan.archived = body.action == "archive"
            plan.updated_at = now_ms()
            return plan_report(db, dataset_id)

    @routes.post("/datasets/{dataset_id}/tasks", status_code=201)
    def submit_task(dataset_id: str, body: RunRequest):
        from .history_maintenance import create_run

        try:
            with transaction() as db:
                version = create_run(db, dataset_id, **body.model_dump())
                return version_report(db, version.id)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/tasks/{version_id}/control")
    def control_task(version_id: str, body: TaskControl):
        from .history_maintenance import task_control

        try:
            with transaction() as db:
                task_control(db, version_id, body.action)
                return version_report(db, version_id)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/datasets", status_code=201)
    def register(body: DatasetRequest):
        try:
            with transaction() as db:
                row, inst = register_history_dataset(db, **body.model_dump())
                return dataset_report(row, inst)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/datasets/{dataset_id}/aggregation", status_code=201)
    def configure(dataset_id: str, body: AggregationRequest):
        try:
            with transaction() as db:
                row, inst, version = change_aggregation(db, dataset_id,
                    body.aggregation_calendar, version_id=body.version_id)
                return {"dataset": dataset_report(row, inst),
                        "version": version_report(db, version.id) if version else None}
        except ValueError as error:
            raise HTTPException(422, str(error)) from None


    @routes.get("/inventory")
    def inventory():
        with transaction() as db:
            return legacy_inventory(db)

    @routes.post("/versions", status_code=201)
    def create(body: VersionRequest):
        try:
            with transaction() as db:
                ident = create_version(db, body.dataset_id, body.start, body.end)
                return version_report(db, ident)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/versions")
    def versions(dataset_id: str | None = None):
        with transaction() as db:
            query = select(HistoryVersion.id).order_by(HistoryVersion.created_at.desc()).limit(100)
            if dataset_id:
                query = query.where(HistoryVersion.dataset_id == dataset_id)
            return [version_report(db, ident) for ident in db.scalars(query)]

    @routes.get("/versions/{ident}")
    def report(ident: str):
        try:
            with transaction() as db:
                return version_report(db, ident)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None

    @routes.get("/versions/{ident}/artifacts")
    def artifacts(ident: str):
        from .history_artifacts import artifact_report

        with transaction() as db:
            if not db.get(HistoryVersion, ident):
                raise HTTPException(404, "历史版本不存在")
            return artifact_report(db, ident)

    @routes.get("/versions/{ident}/coverage")
    def coverage(ident: str, page: int = 1, page_size: int = 25):
        from .data_center import coverage_report

        try:
            with transaction() as db:
                return coverage_report(db, ident, page=page, page_size=page_size)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/versions/{ident}/artifacts", status_code=202)
    def prepare_artifacts(ident: str, body: ArtifactRequest):
        from .history_artifacts import artifact_report, request_artifacts

        try:
            with transaction() as db:
                version = db.get(HistoryVersion, ident)
                if not version:
                    raise HTTPException(404, "历史版本不存在")
                request_artifacts(db, version, body.timeframes)
                return artifact_report(db, ident)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/versions/{ident}/bars")
    def published_bars(ident: str, timeframe: str = "M1", start: int | None = None,
                       end: int | None = None, limit: int = 2000):
        from .history_artifacts import read_artifact

        try:
            with transaction() as db:
                rows = read_artifact(db, ident, timeframe, start=start, end=end, limit=limit)
                return {"version_id": ident, "timeframe": timeframe, "bars": rows}
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/versions/{ident}/chart")
    def historical_chart(ident: str, timeframe: str = "M1", before: int | None = None, count: int = 2000):
        from .history_artifacts import chart_page

        try:
            with transaction() as db:
                return chart_page(db, ident, timeframe, before=before, count=count)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    return routes
