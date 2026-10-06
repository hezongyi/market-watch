"""Authenticated source identities, import controls and immutable version reports."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from .history_versions import create_version, version_report
from .market_datasets import legacy_inventory
from .storage import HistoryVersion, MarketDataset, transaction


class VersionRequest(BaseModel):
    dataset_id: str = Field(min_length=64, max_length=64)
    start: int = Field(ge=0)
    end: int = Field(gt=0)


def router(authenticated):
    routes = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @routes.get("/datasets")
    def datasets():
        with transaction() as db:
            return [{"id": row.id, "instrument_id": row.instrument_id,
                     "logical_symbol": row.logical_symbol, "identity": row.identity,
                     "volume_kind": row.volume_kind, "volume_unit": row.volume_unit}
                    for row in db.scalars(select(MarketDataset).order_by(MarketDataset.logical_symbol))]

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
