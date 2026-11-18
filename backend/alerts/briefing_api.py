"""Authenticated read/save adapters; GET never computes market data."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from . import briefing_service as service
from .storage import BriefingReport, transaction


class SavePlan(BaseModel):
    enabled: bool
    group_ids: list[str] = Field(max_length=100)
    revision: int = Field(ge=0)


class Preview(BaseModel):
    request_id: UUID


def operation(fn, *args, **kwargs):
    try:
        with transaction() as db:
            return fn(db, *args, **kwargs)
    except service.Conflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(409, "请求已在其他窗口提交，请重新读取") from exc


def router(authenticated):
    api = APIRouter(prefix="/api/briefings", dependencies=[Depends(authenticated)])

    @api.get("/plan")
    def plan():
        return operation(service.plan_view)

    @api.post("/plan")
    def save(body: SavePlan):
        return operation(service.save_plan, **body.model_dump())

    @api.post("/preview")
    def preview(body: Preview):
        return operation(service.preview, str(body.request_id))

    @api.get("/reports")
    def history(before: str | None = None, limit: int = 20):
        return operation(service.reports, before=before, limit=limit)

    @api.get("/reports/{report_id}")
    def read(report_id: UUID):
        with transaction() as db:
            row = db.get(BriefingReport, str(report_id))
            if not row:
                raise HTTPException(404, "该期简报不存在")
            return service.report_view(db, row)

    return api
