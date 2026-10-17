"""HTTP surface for the unified notification center (Issue #75)."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from . import notification_center as center
from .storage import transaction


class BrowserEventBody(BaseModel):
    id: str = Field(min_length=4, max_length=80)
    kind: str = "failure"
    severity: str = "warning"
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(default="", max_length=2000)
    occurred_at: int | None = None
    dedupe_key: str | None = Field(default=None, max_length=200)
    context: dict = Field(default_factory=dict)
    links: dict = Field(default_factory=dict)
    actions: dict = Field(default_factory=dict)
    evidence: dict = Field(default_factory=dict)
    profile_id: str | None = Field(default=None, max_length=80)
    notify_web: bool = True


class ObservationBody(BaseModel):
    event_id: str = Field(min_length=1, max_length=80)
    kind: str
    profile_id: str = Field(default="", max_length=80)
    client_at: int | None = None
    dedupe: str = Field(default="", max_length=120)
    result: str | None = Field(default=None, max_length=32)
    meta: dict = Field(default_factory=dict)


def _http_error(exc: Exception):
    if isinstance(exc, KeyError):
        return HTTPException(404, str(exc).strip("'\""))
    if isinstance(exc, center.NotificationConflict):
        return HTTPException(409, {"code": "CONFLICT", "message": str(exc)})
    if isinstance(exc, PermissionError):
        return HTTPException(429, {"code": "RATE_LIMITED", "message": str(exc)})
    if isinstance(exc, IntegrityError):
        return HTTPException(503, {"code": "RETRY", "message": "通知暂不可写入，请稍后重试"})
    return HTTPException(422, str(exc))


def router(authenticated):
    api = APIRouter(prefix="/api/notification-center", dependencies=[Depends(authenticated)])

    @api.get("/events")
    def events(
        limit: int = Query(default=center.PAGE_DEFAULT, ge=1, le=center.PAGE_MAX),
        before: str | None = Query(default=None, max_length=200),
        kind: str | None = Query(default=None, max_length=100),
        severity: str | None = Query(default=None, max_length=100),
        status: str | None = Query(default=None, max_length=20),
        q: str | None = Query(default=None, max_length=100),
        instrument: str | None = Query(default=None, max_length=40),
        workspace: str | None = Query(default=None, max_length=80),
    ):
        kinds = [value for value in (kind or "").split(",") if value]
        severities = [value for value in (severity or "").split(",") if value]
        if any(value not in center.EVENT_KINDS for value in kinds):
            raise HTTPException(422, "未知的通知类型")
        if any(value not in center.SEVERITIES for value in severities):
            raise HTTPException(422, "未知的严重级别")
        if status and status not in ("open", "resolved", "unknown", "all"):
            raise HTTPException(422, "未知的事故状态")
        try:
            with transaction() as db:
                return center.list_events(
                    db, limit=limit, before=before, kinds=kinds or None,
                    severities=severities or None, status=status, query=q,
                    instrument=instrument, workspace=workspace)
        except ValueError as exc:
            raise _http_error(exc) from exc

    @api.get("/events/{event_id}")
    def detail(event_id: str):
        if len(event_id) > 80:
            raise HTTPException(422, "事件 ID 过长")
        try:
            with transaction() as db:
                return center.event_detail(db, event_id)
        except KeyError as exc:
            raise _http_error(exc) from exc

    @api.post("/events")
    def report(body: BrowserEventBody):
        payload = body.model_dump()
        try:
            try:
                event, created = center.record_browser_event(payload)
            except IntegrityError:
                # A concurrent insert won the id/dedupe race; the retry observes
                # the committed row and stays idempotent instead of losing input.
                event, created = center.record_browser_event(payload)
            return {"event": event, "created": created}
        except Exception as exc:  # noqa: BLE001 - mapped to explicit HTTP codes
            raise _http_error(exc) from exc

    @api.post("/observations")
    def observe(body: ObservationBody):
        try:
            with transaction() as db:
                row, created = center.add_observation(
                    db, event_id=body.event_id, kind=body.kind,
                    profile_id=body.profile_id, client_at=body.client_at,
                    dedupe=body.dedupe, result=body.result, meta=body.meta)
                return {"observation": row, "created": created}
        except Exception as exc:  # noqa: BLE001
            raise _http_error(exc) from exc

    @api.get("/changes")
    def changes(
        after_seq: int = Query(default=0, ge=0),
        epoch: str | None = Query(default=None, max_length=36),
        limit: int = Query(default=100, ge=1, le=center.PAGE_MAX),
    ):
        with transaction() as db:
            return center.changes_since(db, after_seq, epoch=epoch, limit=limit)

    @api.post("/incidents/{incident_id}/resolve")
    def resolve(incident_id: str):
        if len(incident_id) > 36:
            raise HTTPException(422, "事故 ID 过长")
        try:
            with transaction() as db:
                return center.resolve_incident(db, incident_id)
        except Exception as exc:  # noqa: BLE001
            raise _http_error(exc) from exc

    @api.get("/summary")
    def summary():
        with transaction() as db:
            window = center.change_window(db)
            page = center.list_events(db, limit=1)
            age = center.projector_age(db)
            return {**window, "unread": page["unread"],
                    "projector_age_ms": age,
                    "projector_ok": age is not None and age <= 120_000}

    @api.get("/stream")
    async def stream(request: Request, after_seq: int = Query(default=0, ge=0),
                     epoch: str | None = Query(default=None, max_length=36)):
        cursor = max(after_seq, int(request.headers.get("last-event-id", "0") or 0))
        known_epoch = epoch

        async def generate():
            nonlocal cursor, known_epoch
            idle = 0
            while not await request.is_disconnected():
                with transaction() as db:
                    batch = center.changes_since(
                        db, cursor, epoch=known_epoch, limit=100)
                if batch.get("reset"):
                    payload = {"reason": batch.get("reason"), "epoch": batch["epoch"],
                               "seq": batch["seq"]}
                    yield f"event: reset\ndata: {json.dumps(payload)}\n\n"
                    known_epoch = batch["epoch"]
                    cursor = batch["seq"]
                    continue
                known_epoch = batch["epoch"]
                for item in batch["items"]:
                    cursor = item["seq"]
                    yield (f"id: {cursor}\nevent: change\n"
                           f"data: {json.dumps(item, ensure_ascii=False)}\n\n")
                if batch.get("more"):
                    idle = 0
                    continue
                await asyncio.sleep(1)
                idle += 1
                if idle >= 15:
                    idle = 0
                    yield ": heartbeat\n\n"

        return StreamingResponse(
            generate(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return api
