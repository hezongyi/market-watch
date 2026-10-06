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
from .storage import HistoryVersion, Instrument, MarketDataset, transaction


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


class AggregationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aggregation_calendar: AggregationCalendar
    version_id: str | None = Field(default=None, min_length=1, max_length=36)


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

    @routes.get("/sources")
    def sources():
        from .source_registry import capabilities

        return [capabilities(source) for source in ("dukascopy", "oanda", "binance", "yahoo")]

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

    return routes
