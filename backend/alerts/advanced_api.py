"""Separate storage: opaque vendor documents never enter legacy workspaces."""

import hashlib
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select, update

from .chart_api import Create, Revision, Save, serialized
from .chart_indicators import public_catalog
from .chart_series import decode
from .storage import AdvancedPreference, AdvancedWorkspace, Preference, now_ms, transaction


class PreferenceWrite(BaseModel):
    kind: Literal["study", "drawing", "chart", "setting"]
    name: str = Field(min_length=1, max_length=250)
    tool: str = Field(default="", max_length=100)
    content: dict
    revision: int = Field(default=0, ge=0)


class NativeChartWrite(BaseModel):
    id: str | None = Field(default=None, max_length=40)
    name: str = Field(min_length=1, max_length=100)
    symbol: str = Field(max_length=80)
    resolution: str = Field(max_length=12)
    content: str = Field(max_length=4_000_000)
    revision: int = Field(default=0, ge=0)

    @field_validator("symbol")
    @classmethod
    def valid_symbol(cls, value):
        from .chart_series import encode
        symbol, kind = decode(value)
        return encode(symbol, kind)


def native_metadata(row):
    return {
        "id": row.id,
        "name": row.name,
        "symbol": row.document.get("symbol", "XAUUSD"),
        "series_kind": decode(row.document.get("symbol", "XAUUSD"))[1],
        "resolution": row.document.get("interval", "240"),
        "timestamp": row.updated_at // 1000,
        "revision": row.revision,
    }


def preference_id(kind, name, tool):
    return hashlib.sha256(json.dumps([kind, name, tool]).encode()).hexdigest()


def preference_json(row):
    return {
        "id": row.id,
        "kind": row.kind,
        "name": row.name,
        "tool": row.tool,
        "content": row.content,
        "revision": row.revision,
    }


def migrate_legacy_templates(db):
    """Copy preview study templates once, preserving conflicts and source documents."""
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy import text

        db.execute(text("SELECT pg_advisory_xact_lock(8675318)"))
    marker = "advanced:legacy-study-templates:v1"
    if db.get(Preference, marker):
        return
    for workspace in db.scalars(select(AdvancedWorkspace).order_by(AdvancedWorkspace.id)):
        templates = workspace.document.get("templates", {})
        if not isinstance(templates, dict):
            continue
        for original, value in templates.items():
            name = str(original)[:250]
            ident = preference_id("study", name, "")
            existing = db.get(AdvancedPreference, ident)
            if existing and existing.content.get("value") == value:
                continue
            if existing:
                suffix = " · " + workspace.id
                name = name[: 250 - len(suffix)] + suffix
                ident = preference_id("study", name, "")
                serial = 1
                while db.get(AdvancedPreference, ident):
                    tail = suffix + "-" + str(serial)
                    name = str(original)[: 250 - len(tail)] + tail
                    ident = preference_id("study", name, "")
                    serial += 1
            db.add(
                AdvancedPreference(
                    id=ident, kind="study", name=name, tool="", content={"value": value}
                )
            )
            db.flush()
    db.add(Preference(key=marker, value={"complete": True, "at": now_ms()}))


def router(authenticated):
    r = APIRouter(prefix="/api/advanced-charts", dependencies=[Depends(authenticated)])

    @r.post("/preferences/migrate")
    def migrate_preferences():
        with transaction() as db:
            migrate_legacy_templates(db)
        return {"ok": True}

    @r.get("/preferences")
    def preferences():
        with transaction() as db:
            return [preference_json(row) for row in db.scalars(select(AdvancedPreference))]

    @r.post("/preferences/save")
    def save_preference(body: PreferenceWrite):
        try:
            if len(json.dumps(body.content, allow_nan=False)) > 1_000_000:
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(422, "设置内容无效或过大")
        ident = preference_id(body.kind, body.name, body.tool)
        with transaction() as db:
            # Serialize catalog mutations, including concurrent first-time inserts.
            if db.get_bind().dialect.name == "postgresql":
                from sqlalchemy import text

                db.execute(text("SELECT pg_advisory_xact_lock(8675318)"))
            row = db.get(AdvancedPreference, ident)
            if row is None:
                if body.revision != 0:
                    raise HTTPException(409, "模板已删除，请重新加载")
                row = AdvancedPreference(
                    id=ident, kind=body.kind, name=body.name, tool=body.tool, content=body.content
                )
                db.add(row)
            else:
                result = db.execute(
                    update(AdvancedPreference)
                    .where(
                        AdvancedPreference.id == ident, AdvancedPreference.revision == body.revision
                    )
                    .values(content=body.content, revision=body.revision + 1, updated_at=now_ms())
                )
                if result.rowcount != 1:
                    raise HTTPException(409, "模板或偏好已在其他窗口修改，请重新加载")
                db.expire(row)
            db.flush()
            return preference_json(row)

    @r.post("/preferences/{ident}/delete")
    def delete_preference(ident: str, body: Revision):
        with transaction() as db:
            result = db.execute(
                delete(AdvancedPreference).where(
                    AdvancedPreference.id == ident, AdvancedPreference.revision == body.revision
                )
            )
            if result.rowcount != 1:
                raise HTTPException(409, "模板或偏好已变更，请重新加载")
        return {"ok": True}

    @r.get("/catalog")
    def catalog():
        return public_catalog()

    @r.get("/native-charts")
    def native_charts():
        with transaction() as db:
            return [
                native_metadata(row)
                for row in db.scalars(
                    select(AdvancedWorkspace).order_by(AdvancedWorkspace.updated_at.desc())
                )
            ]

    @r.get("/native-charts/{ident}")
    def native_content(ident: str):
        with transaction() as db:
            row = db.get(AdvancedWorkspace, ident)
            if not row:
                raise HTTPException(404, "工作区不存在")
            return {
                **native_metadata(row),
                "content": json.dumps(row.document.get("state", {})),
                "document": row.document,
            }

    @r.post("/native-charts/save")
    def native_save(body: NativeChartWrite):
        try:
            state = json.loads(
                body.content, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value))
            )
            if not isinstance(state, dict):
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(422, "图表内容必须是有效JSON对象")
        with transaction() as db:
            if body.id is None:
                if body.revision != 0:
                    raise HTTPException(409, "新工作区版本无效")
                row = AdvancedWorkspace(
                    name=body.name,
                    document={
                        "engine": "tv31",
                        "schemaVersion": 1,
                        "state": state,
                        "symbol": body.symbol,
                        "series_kind": decode(body.symbol)[1],
                        "interval": body.resolution,
                    },
                )
                db.add(row)
                db.flush()
            else:
                row = db.get(AdvancedWorkspace, body.id)
                if not row:
                    raise HTTPException(404, "工作区不存在")
                document = {
                    **row.document,
                    "state": state,
                    "symbol": body.symbol,
                    "series_kind": decode(body.symbol)[1],
                    "interval": body.resolution,
                }
                result = db.execute(
                    update(AdvancedWorkspace)
                    .where(
                        AdvancedWorkspace.id == body.id, AdvancedWorkspace.revision == body.revision
                    )
                    .values(
                        name=body.name,
                        document=document,
                        revision=body.revision + 1,
                        updated_at=now_ms(),
                    )
                )
                if result.rowcount != 1:
                    raise HTTPException(409, "工作区已在其他窗口修改，未覆盖；请另存副本")
                db.expire(row)
            return {**native_metadata(row), "document": row.document}

    @r.get("/workspaces")
    def listing(limit: int | None = Query(default=None, ge=1, le=1000)):
        with transaction() as db:
            query = select(AdvancedWorkspace).order_by(AdvancedWorkspace.updated_at.desc())
            if limit is not None:
                query = query.limit(limit)
            rows = [
                serialized(x)
                for x in db.scalars(query)
            ]
        if limit == 1 and rows:
            ticker = rows[0]['document'].get('symbol', 'XAUUSD')
            try:
                symbol, kind = decode(ticker)
                if kind == 'provider':
                    from .provider_chart import metadata

                    rows[0]['initial_symbol'] = {'ticker': ticker, 'metadata': metadata(symbol)}
            except (HTTPException, ValueError, TimeoutError, RuntimeError):
                # The normal native resolve path reports unavailable/invalid
                # symbols. Never replace the workspace or its series here.
                pass
        return rows

    @r.post("/workspaces")
    def create(body: Create):
        with transaction() as db:
            row = AdvancedWorkspace(name=body.name, document={"engine": "tv31", "schemaVersion": 1,
                                                           "symbol": "MWP:XAUUSD", "series_kind": "provider"})
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
