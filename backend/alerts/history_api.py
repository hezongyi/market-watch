"""Authenticated source identities, import controls and immutable version reports."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from .aggregation_policy import (
    DEFAULTS,
    AggregationCalendar,
    AssetClass,
    register_history_dataset,
)
from .history_versions import create_version, version_report
from .market_datasets import legacy_inventory
from .market_names import display_code
from .storage import (
    HistoryVersion,
    Instrument,
    MarketDataset,
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
    expected_configuration_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
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
    expected_review_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ManagedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset: DatasetRequest
    maintenance: MaintenanceRequest
    request_id: str = Field(min_length=1, max_length=100)
    create_only: bool = False


class CreationCheckRequest(DatasetRequest):
    precision: int | None = Field(default=None, ge=0, le=10, strict=True)
    start_date: str | None = Field(default=None, max_length=10)


def dataset_report(row, inst):
    return {"id": row.id, "instrument_id": row.instrument_id,
            "logical_symbol": row.logical_symbol, "identity": row.identity,
            "display_symbol": display_code(row.logical_symbol, asset_type=row.asset_class),
            "provider_display_symbol": display_code(row.identity["provider_symbol"], row.identity["source"], row.asset_class),
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
    def center_tasks(dataset_id: str | None = None, page: int = 1, page_size: int = 25,
                     query: str = "", source: str | None = None, status: str = "all"):
        from .data_center import task_list

        try:
            with transaction() as db:
                return task_list(db, dataset_id=dataset_id, query=query, source=source, status=status, page=page, page_size=page_size)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/center/task-feed")
    def center_task_feed(dataset_id: str | None = None, query: str = "", source: str | None = None,
                         status: str = "all", page_size: int = 25, snapshot: int | None = None,
                         before: str | None = None, ids: str | None = None):
        from .data_center import task_feed

        try:
            with transaction() as db:
                return task_feed(db, dataset_id=dataset_id, query=query, source=source,
                    status=status, page_size=page_size, snapshot=snapshot, before=before, ids=ids)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/center/platform")
    def center_platform(query: str = "", source: str | None = None, page: int = 1, page_size: int = 25, asset_class: str | None = None):
        from .platform_catalog import catalog

        try:
            with transaction() as db:
                return catalog(db, query=query, source=source, page=page, page_size=page_size, asset=asset_class or None)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

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
        from .history_retention import ReclamationConflict, reclaim

        try:
            with transaction() as db:
                return reclaim(db, dataset_id, body.request_id, expected_review_revision=body.expected_review_revision)
        except ReclamationConflict as error:
            raise HTTPException(409, {"code": "RECLAMATION_CHANGED", "message": str(error),
                                      "references": error.report}) from None
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    @routes.get("/center/creations/{request_id}")
    def creation_result(request_id: str, source: Literal["dukascopy", "oanda"],
                        provider_symbol: str = Query(min_length=1, max_length=64),
                        asset_class: AssetClass = "forex", aggregation_calendar: AggregationCalendar | None = None):
        from .history_commands import lookup_creation

        try:
            with transaction() as db:
                return lookup_creation(db, request_id, source=source, provider_symbol=provider_symbol,
                    asset_class=asset_class, aggregation_calendar=aggregation_calendar)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/center/datasets", status_code=201)
    def create_managed(body: ManagedRequest):
        from .history_commands import CreationConflict
        from .history_commands import create_managed as command

        try:
            with transaction() as db:
                return command(db, body)
        except CreationConflict as error:
            raise HTTPException(409, {"message": str(error), "dataset_id": error.dataset_id}) from None
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/center/datasets/check")
    def check_creation(body: CreationCheckRequest):
        from .history_creation_check import CreationCheckError, check_creation

        try:
            with transaction() as db:
                return check_creation(db, body)
        except CreationCheckError as error:
            return {"status": "invalid", "start": None, "existing": None,
                    "field": error.field, "message": str(error)}
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/history-catalog/search")
    def search_creation_catalog(source: str = "", query: str = "", symbol_type: str = "",
                                offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=100)):
        from .history_creation_check import search_catalog

        try:
            with transaction() as db:
                return search_catalog(db, source=source, query=query, symbol_type=symbol_type,
                                      offset=offset, limit=limit)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/sources")
    def sources():
        from .source_registry import capabilities

        return [capabilities(source) for source in ("dukascopy", "oanda", "binance", "yahoo")]

    @routes.get("/history-catalog")
    def history_catalog(source: str, query: str = "", page: int = 1, page_size: int = 25, symbol_type: str = ""):
        from .history_catalog import catalog

        try:
            with transaction() as db:
                return catalog(db, source=source, query=query, page=page, page_size=page_size, symbol_type=symbol_type)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.get("/versions/{version_id}/comparison")
    def compare_version(version_id: str, previous_version_id: str | None = None):
        from .history_comparison import report

        try:
            with transaction() as db:
                return report(db, version_id, previous_version_id)
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
        from .history_commands import configure_maintenance as command
        from .history_maintenance import MaintenanceConflict

        try:
            with transaction() as db:
                return command(db, dataset_id, body)
        except MaintenanceConflict as error:
            raise HTTPException(409, {"code": "MAINTENANCE_CHANGED", "message": str(error)}) from None
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/datasets/{dataset_id}/maintenance/control")
    def control_maintenance(dataset_id: str, body: MaintenanceControl):
        from .history_commands import control_maintenance

        with transaction() as db:
            try:
                return control_maintenance(db, dataset_id, body.action)
            except ValueError as error:
                raise HTTPException(404, str(error)) from None

    @routes.post("/datasets/{dataset_id}/tasks", status_code=201)
    def submit_task(dataset_id: str, body: RunRequest):
        from .history_commands import submit_task as command

        try:
            with transaction() as db:
                return command(db, dataset_id, body)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @routes.post("/tasks/{version_id}/control")
    def control_task(version_id: str, body: TaskControl):
        from .history_commands import control_task as command

        try:
            with transaction() as db:
                return command(db, version_id, body.action)
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
        from .history_commands import change_aggregation
        try:
            with transaction() as db:
                return change_aggregation(db, dataset_id, body)
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
        from .history_commands import request_artifacts

        try:
            with transaction() as db:
                version = db.get(HistoryVersion, ident)
                if not version:
                    raise HTTPException(404, "历史版本不存在")
                return request_artifacts(db, version.id, body.timeframes)["periods"]
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
