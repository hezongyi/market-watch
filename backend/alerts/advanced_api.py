"""Separate storage: opaque vendor documents never enter legacy workspaces."""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update

from .chart_api import Create, Revision, Save, serialized
from .chart_indicators import CATALOG, calculate
from .storage import AdvancedWorkspace, now_ms, transaction


def router(authenticated):
    r = APIRouter(prefix="/api/advanced-charts", dependencies=[Depends(authenticated)])

    @r.get("/catalog")
    def catalog():
        return {
            name: {
                **meta,
                "series": [
                    {"key": s["key"], "type": s["type"]}
                    for s in calculate([], {"name": name})["series"]
                ],
            }
            for name, meta in CATALOG.items()
        }

    @r.get("/workspaces")
    def listing():
        with transaction() as db:
            return [
                serialized(x)
                for x in db.scalars(
                    select(AdvancedWorkspace).order_by(AdvancedWorkspace.updated_at.desc())
                )
            ]

    @r.post("/workspaces")
    def create(body: Create):
        with transaction() as db:
            row = AdvancedWorkspace(name=body.name, document={"engine": "tv31", "schemaVersion": 1})
            db.add(row)
            db.flush()
            return serialized(row)

    @r.post("/workspaces/{id}/save")
    def save(id: str, body: Save):
        d = body.document
        try:
            valid = (
                d.get("engine") == "tv31"
                and d.get("schemaVersion") == 1
                and len(json.dumps(d, allow_nan=False)) <= 4_000_000
            )
        except (ValueError, TypeError):
            valid = False
        if not valid:
            raise HTTPException(422, "无效图表文档或超过4MB")
        with transaction() as db:
            res = db.execute(
                update(AdvancedWorkspace)
                .where(AdvancedWorkspace.id == id, AdvancedWorkspace.revision == body.revision)
                .values(name=body.name, document=d, revision=body.revision + 1, updated_at=now_ms())
            )
            if res.rowcount != 1:
                raise HTTPException(409, "工作区已变更，请重新加载；当前页面内容尚未保存")
            db.expire_all()
            return serialized(db.get(AdvancedWorkspace, id))

    @r.post("/workspaces/{id}/delete")
    def remove(id: str, body: Revision):
        with transaction() as db:
            res = db.execute(
                delete(AdvancedWorkspace).where(
                    AdvancedWorkspace.id == id, AdvancedWorkspace.revision == body.revision
                )
            )
            if res.rowcount != 1:
                raise HTTPException(409, "工作区已变更，请重新加载")
        return {"ok": True}

    return r
