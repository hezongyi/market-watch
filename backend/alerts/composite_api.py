"""Authenticated composite commands and pure management/chart reads."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .composite_center import (
    candidates,
    detail,
    list_composites,
    mapping_report,
    mappings,
    read_attempts,
)
from .composite_chart import chart_page
from .composite_definitions import ProductMatch, first_use, save_mapping
from .storage import Instrument, transaction


class MappingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    catalog_id: str = Field(min_length=1, max_length=64)
    match: ProductMatch


class UseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: str = Field(min_length=64, max_length=64)
    mapping_id: str = Field(min_length=64, max_length=64)
    client: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9:_-]+$")


def invoke(function, *args, **kwargs):
    try:
        with transaction() as db:
            return function(db, *args, **kwargs)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


def use(db, body):
    from .market_data import renew_demand

    composite = first_use(db, body.dataset_id, body.mapping_id)
    renew_demand(db, body.client, db.get(Instrument, composite.instrument_id))
    return detail(db, composite.id)


def router(authenticated):
    routes = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @routes.get("/center/composites")
    def composites(query: str = "", page: int = 1, page_size: int = 25):
        return invoke(list_composites, query=query, page=page, page_size=page_size)

    @routes.get("/center/composite-candidates")
    def possible(query: str = "", page: int = 1, page_size: int = 25):
        return invoke(candidates, query=query, page=page, page_size=page_size)

    @routes.get("/datasets/{dataset_id}/mappings")
    def saved_mappings(dataset_id: str):
        return invoke(mappings, dataset_id)

    @routes.post("/datasets/{dataset_id}/mappings", status_code=201)
    def save(dataset_id: str, body: MappingRequest):
        def command(db):
            return mapping_report(db, save_mapping(db, dataset_id, body.catalog_id, body.match))
        return invoke(command)

    @routes.post("/composites/use", status_code=201)
    def open_composite(body: UseRequest):
        return invoke(use, body)

    @routes.get("/composites/{composite_id}")
    def composite_detail(composite_id: str):
        return invoke(detail, composite_id)

    @routes.get("/composites/{composite_id}/requests")
    def requests(composite_id: str, page: int = 1, page_size: int = 25):
        return invoke(read_attempts, composite_id, page=page, page_size=page_size)

    @routes.get("/composites/{composite_id}/chart")
    def bars(composite_id: str, timeframe: str = "M1", before: int | None = None, count: int = 300,
             revision_id: str | None = None, input_revision: int | None = None, provisional: bool = False):
        return invoke(chart_page, composite_id, timeframe, before=before, count=count,
            revision_id=revision_id, input_revision=input_revision, provisional=provisional)

    return routes
