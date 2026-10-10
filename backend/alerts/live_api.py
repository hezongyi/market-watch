"""Snapshot/SSE reads consume collection results; browsers never open upstream streams."""

import asyncio
import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from .config import settings
from .live_pricing import account_key, measurements, provider_status, snapshots
from .storage import MarketDataset, MarketDemand, PricingOwner, now_ms, transaction


class Demand(BaseModel):
    client: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    dataset_id: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]+$")


def snapshot_signature(snapshot):
    # Shared cooldowns can change without a quote or LiveState revision.
    return tuple((row["dataset_id"], row["revision"], row["quality"], row["cooldown_until"],
                  row.get('market_session'), row.get('connection_error'), row.get('authentication_hold'),
                  row.get('next_probe_at'))
                 for row in snapshot)


def router(authenticated):
    routes = APIRouter(prefix="/api/market-data/live", dependencies=[Depends(authenticated)])

    @routes.get("")
    def live():
        return snapshots()

    @routes.get('/provider-status')
    def source_status():
        return provider_status()

    @routes.get('/status')
    def status():
        # Low-frequency data-center view; does not create collection demand.
        scope = 'sha256:' + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
        datasets = [row for row in snapshots() if settings.oanda_account_id and all(
            row['identity'].get(key) == value for key, value in {
                'source': 'oanda', 'environment': 'practice', 'channel': 'v20',
                'account_scope': scope}.items())]
        return {'provider': provider_status(), 'datasets': datasets}

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
            scheduled = 0
            for owner in db.scalars(select(PricingOwner).where(PricingOwner.error == "unauthorized",
                                    PricingOwner.id == account_key(settings.oanda_account_id))
                                    .with_for_update()):
                if owner.expires > now_ms():
                    continue
                # Retry schedules validation; it never bypasses the auth hold.
                if owner.next_at <= now_ms():
                    scheduled += 1
            return {"scheduled_authentication_checks": scheduled}

    @routes.get("/events")
    async def events(request: Request):
        async def stream():
            cursor = None
            provider_cursor = None
            cycles = 0
            while not await request.is_disconnected():
                snapshot = await asyncio.to_thread(snapshots)
                signature = snapshot_signature(snapshot)
                if cursor != signature:
                    # Every browser reconnect starts with a full current snapshot.
                    yield "event: snapshot\ndata: " + json.dumps(snapshot) + "\n\n"
                    cursor = signature
                if cycles % 5 == 0:
                    status = await asyncio.to_thread(provider_status)
                    if provider_cursor != status:
                        yield 'event: provider-status\ndata: ' + json.dumps(status) + '\n\n'
                        provider_cursor = status
                cycles += 1
                yield "event: heartbeat\ndata: {}\n\n"
                await asyncio.sleep(1)
        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return routes
