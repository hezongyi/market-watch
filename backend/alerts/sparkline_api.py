"""Authenticated, CSRF-protected watch observations and explicit history preparation."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from .sparklines import batch, prepare


class SparklineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticker: str = Field(min_length=1, max_length=80)
    composite_revision_id: str | None = Field(default=None, min_length=1, max_length=36)


class SparklineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[SparklineItem] = Field(min_length=1, max_length=20)


def router(authenticated):
    routes = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @routes.post("/sparklines")
    def sparklines(body: SparklineRequest):
        return batch(body.items)

    @routes.post("/sparklines/prepare")
    def prepare_sparkline(body: SparklineItem):
        return prepare(body)

    return routes
