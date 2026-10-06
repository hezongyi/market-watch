"""Snapshot/SSE reads consume collection results; browsers never open upstream streams."""

import asyncio
import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from .live_pricing import measurements, snapshots
from .storage import MarketDataset, MarketDemand, PricingOwner, now_ms, transaction


class Demand(BaseModel):
    client: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    dataset_id: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]+$")


def router(authenticated):
    routes = APIRouter(prefix="/api/market-data/live", dependencies=[Depends(authenticated)])

    @routes.get("")
    def live():
        return snapshots()

    @routes.post("/demand")
    def demand(body: Demand):
        with transaction() as db:
            dataset = db.get(MarketDataset, body.dataset_id)
            if not dataset or dataset.identity.get("source") != "oanda":
                raise HTTPException(422, "只有已注册 OANDA 数据集支持实时订阅")
            ident = hashlib.sha256((body.client + "|" + dataset.instrument_id).encode()).hexdigest()[:40]
            row = db.get(MarketDemand, ident)
            if not row:
                row = MarketDemand(id=ident, instrument_id=dataset.instrument_id)
                db.add(row)
            row.expires = now_ms() + 120000
            row.updated_at = now_ms()
            return {"expires": row.expires}

    @routes.get("/metrics/{dataset_id}")
    def metrics(dataset_id: str, since: int = 0):
        if since < 0:
            raise HTTPException(422, "无效测量起点")
        return measurements(dataset_id, since=since)

    @routes.post("/retry")
    def retry():
        with transaction() as db:
            cleared = 0
            for owner in db.scalars(select(PricingOwner).where(PricingOwner.error == "unauthorized")
                                    .with_for_update()):
                if owner.expires > now_ms():
                    continue
                owner.error = None
                owner.next_at = 0
                cleared += 1
            return {"reset_configuration_faults": cleared}

    @routes.get("/events")
    async def events(request: Request):
        async def stream():
            cursor = None
            while not await request.is_disconnected():
                snapshot = await asyncio.to_thread(snapshots)
                signature = tuple((row["dataset_id"], row["revision"], row["quality"]) for row in snapshot)
                if cursor != signature:
                    # Every browser reconnect starts with a full current snapshot.
                    yield "event: snapshot\ndata: " + json.dumps(snapshot) + "\n\n"
                    cursor = signature
                yield "event: heartbeat\ndata: {}\n\n"
                await asyncio.sleep(1)
        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return routes
