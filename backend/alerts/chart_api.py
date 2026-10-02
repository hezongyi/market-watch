"""Authenticated chart APIs with optimistic concurrency and bounded input."""

import asyncio
import copy
import hashlib
import json
import math
import threading
import time
from collections import OrderedDict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, select, update

from .calendar_profile import closures_from
from .chart_data import FRAMES, chart_rows, future_grid
from .chart_history_plan import bucket_has_trading
from .chart_indicators import CATALOG, calculate, validate
from .chart_series import SeriesKind
from .domain import Calendar
from .managed_dataset import data as published_data
from .storage import (
    Bar,
    ChartTemplate,
    ChartWorkspace,
    Instrument,
    instant,
    now_ms,
    transaction,
    uid,
)
from .volume import metadata as volume_metadata


class Create(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class Save(Create):
    revision: int = Field(ge=1)
    document: dict


class Revision(BaseModel):
    revision: int = Field(ge=1)


class Template(Create):
    indicators: list[dict] = Field(max_length=12)


class DataQuery(BaseModel):
    instrument: str
    series_kind: SeriesKind = "managed"
    timeframe: str
    before: int | None = Field(default=None, gt=0)
    limit: int = Field(default=500, ge=1, le=20000)
    from_time: int | None = Field(default=None, alias="from", ge=0)
    count_back: int | None = Field(default=None, alias="countBack", ge=1, le=20000)
    first_data_request: bool = Field(default=False, alias="firstDataRequest")
    client: str | None = Field(default=None, max_length=64)
    indicators: list[dict] = Field(default_factory=list, max_length=12)
    track_history: bool = False
    revision_before: int | None = Field(default=None, gt=0)
    revision_after: int | None = Field(default=None, ge=0)
    published: bool = False
    dataset_start: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_managed_limit(self):
        if self.series_kind == "managed" and self.limit > 2000:
            raise ValueError("自建单页最多2000根")
        return self


class ExportQuery(BaseModel):
    instrument: str = Field(max_length=80)
    series_kind: SeriesKind = "managed"
    published: bool = False
    timeframe: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    indicators: list[dict] = Field(default_factory=list, max_length=12)


class ProviderSubscription(BaseModel):
    client: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    listener: str = Field(min_length=1, max_length=100)
    instrument: str = Field(min_length=1, max_length=80)
    timeframe: str
    cursor: int = Field(default=0, ge=0)
    revision: int = Field(default=0, ge=0)
    observed_at: int = Field(default=0, ge=0)
    indicators: list[dict] = Field(default_factory=list, max_length=1)


class ProviderUnsubscribe(BaseModel):
    client: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    listener: str = Field(min_length=1, max_length=100)


def history_check(db, inst, source, visible, body):
    """Compare a stable prefix, excluding the last streamed candle and new appends."""
    if not body.track_history or not visible:
        return None
    next_before = visible[-1]["start"]
    before = body.revision_before or next_before

    def fingerprint(boundary):
        stamp = db.execute(
            select(func.count(Bar.id), func.sum(Bar.revision + Bar.volume_revision), func.max(Bar.received_at)).where(
                Bar.instrument_id == inst.id,
                Bar.timeframe == source,
                Bar.start < boundary,
                Bar.start >= (body.revision_after or 0),
            )
        ).one()
        return hashlib.sha256(
            json.dumps([list(stamp), inst.calendar_profile], sort_keys=True).encode()
        ).hexdigest()

    revision = fingerprint(before)
    return {
        "before": before,
        "after": body.revision_after,
        "revision": revision,
        "next_before": next_before,
        "next_revision": revision if next_before == before else fingerprint(next_before),
    }


def checked(document):
    if len(json.dumps(document, allow_nan=False)) > 2_000_000:
        raise ValueError("工作区过大")
    if document.get("schemaVersion") != 1:
        raise ValueError("不支持的工作区格式")
    if document.get("layout") not in ("1", "2h", "2v", "3top", "3bottom", "4"):
        raise ValueError("未知布局")
    panels = document.get("panels", [])
    if not isinstance(panels, list) or not all(isinstance(p, dict) for p in panels):
        raise ValueError("无效图表列表")
    for axis in ("splitX", "splitY"):
        v = document.get(axis, 0.5)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.2 <= v <= 0.8:
            raise ValueError("分屏比例无效")
    if (
        not {"1": 1, "2h": 2, "2v": 2, "3top": 3, "3bottom": 3, "4": 4}[document["layout"]]
        <= len(panels)
        <= 4
    ):
        raise ValueError("图表数量无效")
    if len({p.get("id") for p in panels}) != len(panels):
        raise ValueError("图表ID重复")
    for p in panels:
        if not isinstance(p.get("id"), str) or not p["id"]:
            raise ValueError("缺少图表ID")
        try:
            if p.get("timezone", "native") != "native":
                ZoneInfo(p["timezone"])
        except (ZoneInfoNotFoundError, KeyError, TypeError) as exc:
            raise ValueError("未知显示时区") from exc
        view = p.get("range")
        if view and (
            not isinstance(view, dict)
            or not all(
                isinstance(view.get(k), (int, float)) and math.isfinite(view[k])
                for k in ("from", "to")
            )
            or view["from"] >= view["to"]
        ):
            raise ValueError("无效时间视区")
        if p.get("instrument") not in ("EURUSD", "XAUUSD", "BTCUSDT"):
            raise ValueError("未知品种")
        if p.get("timeframe") not in FRAMES:
            raise ValueError("未知周期")
        if len(p.get("indicators", [])) > 12:
            raise ValueError("每图最多12个指标")
        for i in p.get("indicators", []):
            validate(i)
    drawings = document.get("drawings", {})
    if not isinstance(drawings, dict) or sum(len(v) for v in drawings.values()) > 1000:
        raise ValueError("画线数量超出限制")
    for symbol, objects in drawings.items():
        if (
            symbol not in ("EURUSD", "XAUUSD", "BTCUSDT")
            or not isinstance(objects, list)
            or not all(isinstance(o, dict) for o in objects)
        ):
            raise ValueError("无效画线品种")
        if len({o.get("id") for o in objects}) != len(objects):
            raise ValueError("画线ID重复")
        for obj in objects:
            if not isinstance(obj.get("id"), str) or not isinstance(obj.get("options", {}), dict):
                raise ValueError("无效画线对象")
            for point in obj.get("points", []):
                if not all(
                    isinstance(point.get(k), (int, float))
                    and math.isfinite(point[k])
                    and point[k] > 0
                    for k in ("timestamp", "price")
                ):
                    raise ValueError("无效画线坐标")
            if obj.get("toolType") not in (
                "HorizontalLine",
                "TrendLine",
                "Ray",
                "Rectangle",
                "FibRetracement",
                "Text",
                "ParallelChannel",
                "LongShortPosition",
            ):
                raise ValueError("未知画线类型")
            required = {
                "HorizontalLine": 1,
                "Text": 1,
                "ParallelChannel": 3,
                "LongShortPosition": 3,
            }.get(obj["toolType"], 2)
            if len(obj.get("points", [])) != required:
                raise ValueError("画线锚点数量无效")
            if obj["toolType"] == "LongShortPosition":
                entry, stop, target = (p["price"] for p in obj["points"])
                if (stop - entry) * (target - entry) >= 0:
                    raise ValueError("止损与止盈必须分居入场价两侧")
    return document


def serialized(row):
    return {
        "id": row.id,
        "name": row.name,
        "document": row.document,
        "revision": row.revision,
        "updated_at": row.updated_at,
    }


_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()
_RESULT_CACHE = OrderedDict()


def router(authenticated):
    r = APIRouter(prefix="/api/charts", dependencies=[Depends(authenticated)])

    @r.post("/provider/subscribe")
    def provider_subscribe(body: ProviderSubscription):
        from .provider_service import subscribe

        if body.timeframe not in FRAMES:
            raise HTTPException(422, "不支持的周期")
        try:
            for spec in body.indicators:
                validate(spec)
            return subscribe(body.client, body.listener, body.instrument, body.timeframe,
                             body.cursor, body.revision, body.observed_at, body.indicators)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @r.post("/provider/unsubscribe")
    def provider_unsubscribe(body: ProviderUnsubscribe):
        from .provider_service import unsubscribe

        unsubscribe(body.client, body.listener)
        return {"ok": True}

    @r.get("/provider/events")
    async def provider_events(request: Request, client: str):
        import re

        from .provider_service import events, renew

        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", client):
            raise HTTPException(422, "无效客户端")

        async def stream():
            cursors = {}
            while not await request.is_disconnected():
                await asyncio.to_thread(renew, client)
                messages = await asyncio.to_thread(events, client, cursors)
                for message in messages:
                    yield "data: " + json.dumps(message) + "\n\n"
                yield ": heartbeat\n\n"
                await asyncio.sleep(2)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
        })

    @r.get("/catalog")
    def catalog():
        return {"frames": FRAMES, "indicators": CATALOG}

    @r.post("/export")
    def export(body: ExportQuery):
        from .chart_data import bounds
        from .chart_export import chart_csv
        from .coverage import covers_interval
        from .domain import bucket_bounds
        from .market_data import (
            FRAME_MS,
            missing_intervals,
            queue_history,
            resolve,
            stored_coverage,
        )
        from .storage import ms

        if body.timeframe not in FRAMES or not 0 < body.end - body.start <= 366 * 86400000:
            raise HTTPException(422, "请选择有效周期及不超过366天的导出范围")
        try:
            for spec in body.indicators:
                validate(spec)
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise HTTPException(422, str(error)) from error
        if body.series_kind == "provider":
            page = data_sync(DataQuery(instrument=body.instrument, series_kind="provider",
                                  timeframe=body.timeframe, before=body.end, limit=2000,
                                  indicators=body.indicators))
            if len(page["bars"]) == 2000 and page["has_more"] and page["bars"][0]["chart_time"] > body.start:
                raise HTTPException(413, "单次最多导出2000根K线，请缩小日期范围")
            page["bars"] = [b for b in page["bars"] if body.start <= b["chart_time"] < body.end]
            return Response(chart_csv(page, instrument=body.instrument, timeframe=body.timeframe),
                            media_type="text/csv; charset=utf-8",
                            headers={"Content-Disposition": 'attachment; filename="market-watch.csv"',
                                     "Cache-Control": "no-store"})
        if body.published:
            from .storage import ChartPublication
            with transaction() as db:
                publication = db.get(ChartPublication, (body.instrument, body.timeframe))
                if not publication or body.start < publication.start or body.end > publication.end:
                    raise HTTPException(409, "导出范围尚未发布，请通过维护历史入口明确提交起点，并等待相应周期完成")
            page = data_sync(DataQuery(instrument=body.instrument, timeframe=body.timeframe,
                                  before=body.end, limit=2000, indicators=body.indicators,
                                  published=True))
            if len(page['bars']) == 2000 and page['has_more'] and page['bars'][0]['start'] > body.start:
                raise HTTPException(413, "单次最多导出2000根K线，请缩小日期范围")
            page['bars'] = [bar for bar in page['bars'] if body.start <= bar['start'] < body.end]
            return Response(chart_csv(page, instrument=body.instrument, timeframe=body.timeframe),
                            media_type="text/csv; charset=utf-8",
                            headers={"Content-Disposition": 'attachment; filename="market-watch.csv"',
                                     "Cache-Control": "no-store"})
        with transaction() as db:
            inst = resolve(db, body.instrument)
            calendar = Calendar(inst.calendar)
            boundary = bounds if body.timeframe in ("M30", "W1", "MN") else bucket_bounds
            left = ms(boundary(instant(body.start), body.timeframe, calendar)[0])
            right = min(
                ms(boundary(instant(body.end - 1), body.timeframe, calendar)[1]),
                (now_ms() - 5000) // 60000 * 60000,
            )
            if left >= right:
                raise HTTPException(422, "导出范围尚无可获取的行情")
            # Reject known oversized exports before creating any download jobs.
            # Count actual candles, not elapsed minutes: closures may leave a
            # long interval with very few bars.
            if (body.end - body.start) // FRAME_MS[body.timeframe] >= 2000:
                existing = chart_rows(db, inst, body.timeframe, body.end, 2001, now_ms())
                if len(existing) > 2000 and existing[0]["start"] >= body.start:
                    raise HTTPException(413, "单次最多导出2000根K线，请缩小日期范围")
            if body.timeframe != "MN":
                coverage = stored_coverage(db, inst, left, right)
                missing = list(missing_intervals(coverage, left, right))
                jobs = []
                if missing:
                    # Discover cold history in bounded windows. The next poll checks
                    # the row limit again before scheduling further backfill.
                    a, b = missing[-1]
                    span = max(4000 * 60000, min(31 * 86400000, 2001 * FRAME_MS[body.timeframe]))
                    jobs, planned_coverage = queue_history(db, inst, max(a, b - span), b)
                    coverage = coverage + planned_coverage
                if not covers_interval(coverage, left, right):
                    failed = [job for job in jobs if job.status == "failed"]
                    return JSONResponse(
                        status_code=409 if failed else 202,
                        content={
                            "status": "error" if failed else "pending",
                            "task_ids": [
                                job.id for job in jobs if job.status in ("pending", "running")
                            ],
                            "failed_task_ids": [job.id for job in failed],
                            "retry_after": 2,
                            "message": "历史补数失败，请重试"
                            if failed
                            else "正在补齐导出范围内的历史行情",
                        },
                    )
            instrument = inst.id
        page = data_sync(
            DataQuery(
                instrument=instrument,
                timeframe=body.timeframe,
                before=body.end,
                limit=2000,
                indicators=body.indicators,
            )
        )
        if len(page["bars"]) == 2000 and page["bars"][0]["start"] > body.start:
            # A leading market closure can leave exactly 2000 bars after start.
            # Probe one predecessor instead of treating empty time as an extra bar.
            previous = data_sync(
                DataQuery(
                    instrument=instrument,
                    timeframe=body.timeframe,
                    before=page["bars"][0]["start"],
                    limit=1,
                )
            )
            if previous["bars"] and previous["bars"][-1]["start"] >= body.start:
                raise HTTPException(413, "单次最多导出2000根K线，请缩小日期范围")
        page["bars"] = [bar for bar in page["bars"] if body.start <= bar["start"] < body.end]
        return Response(
            chart_csv(page, instrument=instrument, timeframe=body.timeframe),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": 'attachment; filename="market-watch.csv"',
                "Cache-Control": "no-store",
            },
        )

    @r.get("/workspaces")
    def listing():
        with transaction() as db:
            return [
                serialized(x)
                for x in db.scalars(
                    select(ChartWorkspace).order_by(ChartWorkspace.updated_at.desc())
                )
            ]

    @r.post("/workspaces")
    def create(body: Create):
        with transaction() as db:
            row = ChartWorkspace(
                name=body.name,
                document={
                    "schemaVersion": 1,
                    "layout": "1",
                    "sync": True,
                    "drawings": {},
                    "panels": [
                        {
                            "id": uid(),
                            "instrument": "XAUUSD",
                            "timeframe": "H4",
                            "indicators": [],
                            "timezone": "native",
                            "follow": True,
                        }
                    ],
                },
            )
            db.add(row)
            db.flush()
            return serialized(row)

    @r.post("/workspaces/{id}/save")
    def save(id: str, body: Save):
        try:
            checked(body.document)
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            raise HTTPException(422, str(e)) from e
        with transaction() as db:
            if not db.get(ChartWorkspace, id):
                raise HTTPException(404, "工作区不存在")
            res = db.execute(
                update(ChartWorkspace)
                .where(ChartWorkspace.id == id, ChartWorkspace.revision == body.revision)
                .values(
                    name=body.name,
                    document=body.document,
                    revision=body.revision + 1,
                    updated_at=now_ms(),
                )
            )
            if res.rowcount != 1:
                raise HTTPException(409, "工作区已在其他窗口修改，请重新加载或另存副本")
            db.expire_all()
            return serialized(db.get(ChartWorkspace, id))

    @r.post("/workspaces/{id}/copy")
    def duplicate(id: str, body: Save):
        try:
            document = copy.deepcopy(checked(body.document))
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            raise HTTPException(422, str(e)) from e
        for objects in document.get("drawings", {}).values():
            for obj in objects:
                obj["id"] = uid()
        with transaction() as db:
            row = ChartWorkspace(name=body.name, document=document)
            db.add(row)
            db.flush()
            return serialized(row)

    @r.post("/workspaces/{id}/delete")
    def remove(id: str, body: Revision):
        with transaction() as db:
            res = db.execute(
                delete(ChartWorkspace).where(
                    ChartWorkspace.id == id, ChartWorkspace.revision == body.revision
                )
            )
            if res.rowcount != 1:
                raise HTTPException(409, "工作区已变更，请刷新列表")
        return {"ok": True}

    @r.get("/templates")
    def templates():
        with transaction() as db:
            return [
                {"id": x.id, "name": x.name, "indicators": x.indicators}
                for x in db.scalars(select(ChartTemplate))
            ]

    @r.post("/templates")
    def add_template(body: Template):
        try:
            for spec in body.indicators:
                validate(spec)
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            raise HTTPException(422, str(e)) from e
        with transaction() as db:
            row = ChartTemplate(name=body.name, indicators=body.indicators)
            db.add(row)
            db.flush()
            return {"id": row.id}

    @r.post("/templates/{id}/delete")
    def remove_template(id: str):
        with transaction() as db:
            db.execute(delete(ChartTemplate).where(ChartTemplate.id == id))
        return {"ok": True}

    @r.post("/data")
    async def data(body: DataQuery, request: Request):
        if body.series_kind != "provider":
            return await asyncio.to_thread(data_sync, body)
        from .config import settings
        from .provider_cache import CANCELLED, DEADLINE

        cancelled = threading.Event()
        token = CANCELLED.set(cancelled)
        deadline = time.monotonic() + settings.provider_request_seconds
        deadline_token = DEADLINE.set(deadline)
        task = asyncio.create_task(asyncio.to_thread(data_sync, body))
        try:
            while not task.done():
                if await request.is_disconnected():
                    cancelled.set()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HTTPException(503, "平台行情暂不可用，请重试；尚未确认历史边界")
                await asyncio.wait({task}, timeout=min(0.05, remaining))
            return await task
        finally:
            cancelled.set()
            CANCELLED.reset(token)
            DEADLINE.reset(deadline_token)
            if not task.done():
                # An already sent page can still populate the shared cache;
                # observe its exception even if the HTTP waiter disappeared.
                task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)

    def data_sync(body: DataQuery):
        try:
            for spec in body.indicators:
                validate(spec)
            if body.series_kind == "provider":
                import httpx

                from .provider_chart import data as provider_data

                try:
                    return provider_data(body)
                except (httpx.HTTPError, TimeoutError) as error:
                    raise HTTPException(503, "平台行情暂不可用，请重试；尚未确认历史边界") from error
            if body.published:
                return published_data(body)
            with transaction() as db:
                inst = db.get(Instrument, body.instrument)
                if not inst:
                    raise HTTPException(404, "品种不存在")
                before = body.before or now_ms() + 1
                # All persisted source history is the common recursive indicator prefix.
                # New bars never move its origin; backfill/revisions deliberately invalidate it.
                source = (
                    "M15"
                    if body.timeframe == "M30"
                    else "D1"
                    if body.timeframe in ("W1", "MN")
                    else body.timeframe
                )
                if not body.indicators:
                    # Ordinary chart pagination must not materialize all available history.
                    page = chart_rows(db, inst, body.timeframe, before, body.limit + 1, now_ms())
                    visible = page[-body.limit :]
                    revision_at = db.scalar(
                        select(func.sum(Bar.revision + Bar.volume_revision)).where(
                            Bar.instrument_id == inst.id, Bar.timeframe == source
                        )
                    )
                    return {
                        "history_check": history_check(db, inst, source, visible, body),
                        "history_revision": str(revision_at or 0),
                        "bars": visible,
                        "indicators": [],
                        "has_more": len(page) > body.limit,
                        "origin": db.scalar(
                            select(func.min(Bar.start)).where(
                                Bar.instrument_id == inst.id, Bar.timeframe == source
                            )
                        ),
                        "bounded_history": False,
                        "future": future_grid(inst, body.timeframe, visible[-1]["end"])
                        if visible
                        else [],
                        "basis": inst.basis,
                        **volume_metadata(inst.source, inst.symbol),
                        "calendar": inst.calendar,
                        "precision": inst.precision,
                        "as_of": now_ms(),
                    }
                stamp = db.execute(
                    select(
                        func.count(Bar.id),
                        func.max(Bar.received_at),
                        func.sum(Bar.revision + Bar.volume_revision),
                        func.min(Bar.start),
                        func.max(Bar.start),
                    ).where(Bar.instrument_id == inst.id, Bar.timeframe == source)
                ).one()
                key = (
                    str(db.get_bind().url),
                    inst.id,
                    body.timeframe,
                    tuple(stamp),
                    json.dumps(inst.calendar_profile, sort_keys=True),
                )
                with _CACHE_LOCK:
                    cached = _CACHE.get(key)
                cache_hit = bool(cached and time.monotonic() - cached[0] < 15)
                if cache_hit:
                    all_rows = cached[1]
                else:
                    all_rows = chart_rows(
                        db, inst, body.timeframe, now_ms() + 1, max(1, stamp[0]), now_ms()
                    )
                visible = [x for x in all_rows if x["start"] < before][-body.limit :]
                history_snapshot = history_check(db, inst, source, visible, body)
                # No lazy ORM reads during CPU work after returning the connection.
                db.expunge(inst)
            if not cache_hit:
                closures = closures_from(inst.calendar_profile)
                for prev, row in zip(all_rows, all_rows[1:]):
                    if prev["end"] < row["start"]:
                        row["gap_before"] = bucket_has_trading(
                            instant(prev["end"]),
                            instant(row["start"]),
                            Calendar(inst.calendar),
                            gold=inst.id == "XAUUSD",
                            closures=closures,
                        )
                with _CACHE_LOCK:
                    _CACHE[key] = (time.monotonic(), all_rows)
                    while len(_CACHE) > 16 or sum(len(v[1]) for v in _CACHE.values()) > 200_000:
                        _CACHE.popitem(last=False)
            visible = [x for x in all_rows if x["start"] < before][-body.limit :]
            start = visible[0]["start"] if visible else before
            end = visible[-1]["start"] if visible else before
            indicators = []
            for spec in body.indicators:
                name, params = validate(spec)
                result_key = (
                    key,
                    name,
                    spec.get("version", "1"),
                    json.dumps(params, sort_keys=True),
                )
                with _CACHE_LOCK:
                    cached_result = _RESULT_CACHE.get(result_key)
                if cached_result and time.monotonic() - cached_result[0] < 15:
                    result = cached_result[1]
                else:
                    result = calculate(all_rows, spec)
                    weight = sum(len(series["values"]) for series in result["series"])
                    with _CACHE_LOCK:
                        _RESULT_CACHE[result_key] = (time.monotonic(), result, weight)
                        while (
                            len(_RESULT_CACHE) > 64
                            or sum(v[2] for v in _RESULT_CACHE.values()) > 250_000
                        ):
                            _RESULT_CACHE.popitem(last=False)
                indicators.append(
                    {
                        **result,
                        "id": spec.get("id", spec["name"]),
                        "series": [
                            {
                                **series,
                                "values": [
                                    v for v in series["values"] if start <= v["time"] <= end
                                ],
                            }
                            for series in result["series"]
                        ],
                    }
                )
            return {
                "history_check": history_snapshot,
                "history_revision": hashlib.sha256(
                    json.dumps(
                        [stamp[0], stamp[2], stamp[3], inst.calendar_profile], sort_keys=True
                    ).encode()
                ).hexdigest(),
                "bars": visible,
                "indicators": indicators,
                "has_more": bool(visible and any(x["start"] < start for x in all_rows)),
                "origin": all_rows[0]["start"] if all_rows else None,
                "bounded_history": False,
                "future": future_grid(inst, body.timeframe, all_rows[-1]["end"])
                if all_rows
                else [],
                "basis": inst.basis,
                        **volume_metadata(inst.source, inst.symbol),
                "calendar": inst.calendar,
                "precision": inst.precision,
                "as_of": now_ms(),
            }
        except (ValueError, TypeError, KeyError, AttributeError) as e:
            raise HTTPException(422, str(e)) from e

    return r
