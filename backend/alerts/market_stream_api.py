"""Authenticated registration and one durable-result SSE connection per page."""

import asyncio
import hashlib
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from . import market_stream as stream
from .chart_api import DataQuery
from .chart_data import FRAMES
from .chart_indicators import validate
from .storage import CompositeRevision, Instrument, transaction


class Consumer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    listener: str = Field(min_length=1, max_length=100)
    generation: int = Field(ge=1, le=2**53 - 1)


class Subscription(Consumer):
    kind: str = Field(pattern="^(bars|quotes)$")
    query: DataQuery
    cursor: int = Field(default=0, ge=0)
    sequence: int = Field(default=0, ge=0)
    result_epoch: str | None = Field(default=None, max_length=36)
    loaded_after: int | None = Field(default=None, ge=0)
    loaded_before: int | None = Field(default=None, ge=0)
    history_revision: str | None = Field(default=None, max_length=128)
    history_tail_revision: str | None = Field(default=None, max_length=128)
    historical: bool = False
    history_accepted: bool = True
    history_plot_width: float = Field(default=960, gt=0, le=16384)
    history_bar_spacing: float = Field(default=6, gt=0, le=1000)
    binding: str | None = Field(default=None, max_length=64)
    observed_at: int = Field(default=0, ge=0)
    initial_input_revision: int | None = Field(default=None, ge=0)
    display_snapshot_id: str | None = Field(default=None, min_length=64, max_length=64)
    initial_indicator_pending: bool = False
    # Consumer evidence only: the shared price task still has no indicator IO.
    dependency_origin: int | None = Field(default=None, ge=0)
    dependency_observed_at: int | None = Field(default=None, ge=0)
    dependency_before: int | None = Field(default=None, gt=0)
    dependency_revision: str | None = Field(default=None, max_length=128)


def resolve(body):
    """Resolve full series identity before sharing; display symbols are insufficient."""
    query = body.query.model_copy(update={"client": None, "before": None, "limit": 2000,
        "track_history": False, "from_time": None, "count_back": None,
        "first_data_request": False, "revision_before": None, "revision_after": None,
        "native_history": None, "history_observation": None, "native_reserve": None, "display_snapshot_id": None})
    if query.timeframe not in FRAMES:
        raise ValueError("不支持的周期")
    for spec in query.indicators:
        validate(spec)
    if body.kind == "quotes" and query.indicators:
        raise ValueError("报价不接受指标")
    identity = {"kind": body.kind, "series_kind": query.series_kind, "instrument": query.instrument,
                "timeframe": query.timeframe if body.kind == "bars" else None,
                "indicators": query.indicators if body.kind == "bars" else []}
    if query.series_kind == "provider":
        from .provider_cache import ensure
        from .provider_cache import identity as provider_identity
        from .provider_chart import metadata

        meta = metadata(query.instrument)
        identity["dataset_id"] = provider_identity(meta, query.timeframe if body.kind == "bars" else "M1")
        identity["metadata"] = meta
        if body.kind == "bars":
            ensure(meta, query.timeframe)
    elif query.series_kind in ("history", "composite"):
        from .series_access import composite_definition, metadata

        with transaction() as db:
            identity["metadata"] = metadata(db, query.instrument, query.series_kind)
            if query.series_kind == "composite":
                _, _, composite = composite_definition(db, query.instrument)
                if not composite:
                    raise ValueError("组合尚未建立；订阅不能隐式创建组合")
                selected = db.get(CompositeRevision, query.composite_revision_id or composite.active_revision_id)
                if not selected or selected.composite_id != composite.id:
                    raise ValueError("组合修订不属于所选系列")
                identity["revision_id"] = query.composite_revision_id
                identity["follow_active"] = query.composite_revision_id is None
    else:
        with transaction() as db:
            inst = db.get(Instrument, query.instrument)
            if not inst:
                raise ValueError("品种不存在")
            identity["metadata"] = {"source": inst.source, "symbol": inst.symbol,
                                    "basis": inst.basis, "calendar": inst.calendar,
                                    "calendar_profile": inst.calendar_profile}
        identity["dataset_start"] = query.dataset_start
        identity["published"] = query.published
    identity["input_revision"] = query.input_revision
    identity["calculation_origin"] = query.calculation_origin
    identity["provisional"] = query.provisional
    return identity, query.model_dump(by_alias=True)


def router(authenticated):
    r = APIRouter(prefix="/api/charts/stream", dependencies=[Depends(authenticated)])

    def session_hash(request):
        return hashlib.sha256(request.cookies.get("session", "").encode()).hexdigest()

    @r.post("/subscribe")
    def subscribe(body: Subscription, request: Request):
        try:
            identity, query = resolve(body)
            state = body.model_dump(exclude={"query", "client", "listener", "generation", "kind"})
            return stream.register(session_hash(request), body.client, body.listener,
                                   body.generation, identity, query, state)
        except (ValueError, TypeError, KeyError) as error:
            raise HTTPException(422, str(error)) from None

    @r.post("/unsubscribe")
    def unsubscribe(body: Consumer, request: Request):
        stream.cancel(session_hash(request), body.client, body.listener, body.generation)
        return {"ok": True}

    @r.get("/events")
    async def events(request: Request, client: str):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", client):
            raise HTTPException(422, "无效客户端")
        owner = session_hash(request)

        async def messages():
            cursors = {}
            while not await request.is_disconnected():
                try:
                    await asyncio.to_thread(stream.renew, owner, client)
                    rows = await asyncio.to_thread(stream.events, owner, client, cursors)
                except PermissionError:
                    return
                for row in rows:
                    yield "data: " + json.dumps(row) + "\n\n"
                yield "event: heartbeat\ndata: {}\n\n"
                await asyncio.sleep(.5)

        return StreamingResponse(messages(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return r
