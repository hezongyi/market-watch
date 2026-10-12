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
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, func, select, update

from .calendar_profile import closures_from
from .chart_data import FRAMES, chart_rows, future_grid
from .chart_history_plan import bucket_has_trading
from .chart_indicators import calculate, public_catalog, validate
from .chart_series import SeriesKind, decode, is_gold
from .domain import calendar_for
from .managed_dataset import data as published_data
from .native_series import OandaParameters
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


class NativeConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instrument: str = Field(min_length=1, max_length=40)
    parameters: OandaParameters


class Save(Create):
    revision: int = Field(ge=1)
    document: dict


class Revision(BaseModel):
    revision: int = Field(ge=1)


class Template(Create):
    indicators: list[dict] = Field(max_length=12)


class NativeHistory(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    chart_count: int = Field(ge=1, le=8)
    focused: bool | None = None
    historical_navigation: bool = False
    screen_bars: int | None = Field(default=None, ge=1, le=2000)
    batch_screens: int = Field(default=1, ge=1, le=2)


class HistoryObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    revision: int = Field(ge=0)
    observed_at: int = Field(ge=0)
    first: int = Field(ge=0)
    last: int = Field(ge=0)

    @model_validator(mode="after")
    def ordered_window(self):
        if self.first > self.last:
            raise ValueError("历史观察窗口无效")
        return self


class NativeReserve(BaseModel):
    """Optional, PG-only history for a visible chart; never upstream demand."""
    model_config = ConfigDict(extra="forbid", strict=True)
    screen_bars: int = Field(ge=1, le=2000)
    batch_screens: int = Field(ge=1, le=2)
    warmup_bars: int = Field(default=0, ge=0, le=2000)


class DataQuery(BaseModel):
    # v1.3.2 compatibility: optional fields from newer bridges remain ignorable.
    model_config = ConfigDict(extra="ignore")
    instrument: str
    series_kind: SeriesKind = "managed"
    timeframe: str
    before: int | None = Field(default=None, gt=0)
    limit: int = Field(default=500, ge=1, le=1000000)
    from_time: int | None = Field(default=None, alias="from", ge=0)
    count_back: int | None = Field(default=None, alias="countBack", ge=1, le=1000000)
    first_data_request: bool = Field(default=False, alias="firstDataRequest")
    client: str | None = Field(default=None, max_length=64)
    indicators: list[dict] = Field(default_factory=list, max_length=12)
    track_history: bool = False
    revision_before: int | None = Field(default=None, gt=0)
    revision_after: int | None = Field(default=None, ge=0)
    published: bool = False
    dataset_start: int | None = Field(default=None, ge=0)
    calculation_origin: int | None = Field(default=None, ge=0)
    dependency_before: int | None = Field(default=None, gt=0)
    provisional: bool = True
    composite_revision_id: str | None = Field(default=None, max_length=36)
    input_revision: int | None = Field(default=None, ge=0)
    native_history: NativeHistory | None = None
    history_observation: HistoryObservation | None = None
    native_reserve: NativeReserve | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_native_input_types(cls, value):
        if isinstance(value, dict) and value.get("native_history") is not None:
            for field in ("before", "from", "countBack", "limit"):
                raw = value.get(field)
                if raw is not None and (not isinstance(raw, int) or isinstance(raw, bool)):
                    raise ValueError("原生历史数量与时间须为整数")
            if "firstDataRequest" in value and not isinstance(value["firstDataRequest"], bool):
                raise ValueError("firstDataRequest须为布尔值")
        return value

    @model_validator(mode="after")
    def validate_managed_limit(self):
        if self.native_reserve is not None:
            if (self.series_kind != "provider" or self.native_history is None or
                    self.indicators or self.history_observation is not None or self.before is None):
                raise ValueError("图表储备只适用于带原生上下文的纯平台历史缓存读取")
        if self.series_kind == "provider" and self.native_history is None and max(self.limit, self.count_back or 0) > 20000:
            raise ValueError("普通平台单页最多20000根")
        if self.series_kind != "provider" and self.limit > 2000:
            raise ValueError("自建单页最多2000根")
        if self.native_history is not None or self.history_observation is not None:
            if self.series_kind != "provider":
                raise ValueError("原生历史上下文仅适用于平台行情")
            if self.history_observation is not None and self.native_history is None:
                raise ValueError("历史复核需要原生历史上下文")
            if self.from_time is not None and self.before is not None and self.from_time >= self.before:
                raise ValueError("原生历史区间须满足from<to")
        return self


class HistoryLoadQuery(BaseModel):
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9._:-]+$")
    query: DataQuery


class HistoryCapacityWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    max_bars: int


class ExportQuery(BaseModel):
    instrument: str = Field(max_length=80)
    series_kind: SeriesKind = "managed"
    published: bool = False
    timeframe: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    indicators: list[dict] = Field(default_factory=list, max_length=12)
    composite_revision_id: str | None = Field(default=None, max_length=36)
    input_revision: int | None = Field(default=None, ge=0)


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
    if not visible:
        return None
    next_before = visible[-1]["start"]
    before = body.revision_before or next_before

    def fingerprint(boundary):
        stamp = db.execute(
            select(func.count(Bar.id), func.sum(Bar.revision + Bar.volume_revision), func.max(Bar.received_at)).where(
                Bar.instrument_id == inst.id,
                Bar.timeframe == source,
                Bar.start < boundary,
                Bar.start >= (0 if body.indicators else body.revision_after or 0),
            )
        ).one()
        return hashlib.sha256(
            json.dumps([list(stamp), inst.calendar_profile], sort_keys=True).encode()
        ).hexdigest()

    def tail_fingerprint(boundary):
        # The realtime prefix deliberately excludes this target bucket. A
        # historical consumer also retains it, including every M15/D1 member.
        if body.timeframe in ("M30", "W1", "MN"):
            from .chart_data import bounds
            from .domain import calendar_for
            from .storage import instant, ms

            end = ms(bounds(instant(boundary), body.timeframe, calendar_for(inst))[1])
        else:
            end = boundary + 1
        stamp = db.execute(select(
            func.count(Bar.id), func.sum(Bar.revision + Bar.volume_revision), func.max(Bar.received_at)
        ).where(Bar.instrument_id == inst.id, Bar.timeframe == source,
                Bar.start >= boundary, Bar.start < end)).one()
        return hashlib.sha256(json.dumps([list(stamp), inst.calendar_profile], sort_keys=True).encode()).hexdigest()

    if not body.track_history:
        tail_revision = tail_fingerprint(next_before)
        return {"before": next_before, "after": body.revision_after,
                "tail_revision": tail_revision, "next_tail_revision": tail_revision}

    revision = fingerprint(before)
    tail_revision = tail_fingerprint(before)
    return {
        "before": before,
        "after": body.revision_after,
        "revision": revision,
        "next_before": next_before,
        "next_revision": revision if next_before == before else fingerprint(next_before),
        "tail_revision": tail_revision,
        "next_tail_revision": tail_revision if next_before == before else tail_fingerprint(next_before),
    }


def checked(document):
    from .storage import MarketDataset

    with transaction() as db:
        managed_symbols = {"EURUSD", "XAUUSD", "BTCUSDT"}
        managed_symbols.update(db.scalars(select(MarketDataset.instrument_id)))
        from .history_retention import string_values
        from .series_access import metadata

        for value in string_values(document):
            if value.startswith(("MWH:", "MWC:")):
                ident, kind = decode(value)
                metadata(db, ident, kind)
                managed_symbols.add(value)
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
        if p.get("instrument") not in managed_symbols:
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
            symbol not in managed_symbols
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

    @r.post("/provider/configure")
    def native_configuration(body: NativeConfiguration):
        from .chart_series import encode
        from .native_series import register
        from .provider_chart import metadata
        try:
            meta = register(metadata(body.instrument), body.parameters.model_dump())
            return {"ticker": encode(meta["id"], "provider"), "metadata": meta}
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @r.post("/provider/subscribe")
    def provider_subscribe(body: ProviderSubscription):
        from .provider_service import subscribe

        if body.timeframe not in FRAMES:
            raise HTTPException(422, "不支持的周期")
        try:
            for spec in body.indicators:
                validate(spec)
                origin = spec.get("calculation_origin")
                if origin is not None and (type(origin) is not int or origin < 0):
                    raise ValueError("指标固定历史起点须为非负整数")
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
        from .storage import MarketDataset

        with transaction() as db:
            sources = [{"id": row.instrument_id, "symbol": row.logical_symbol,
                        "source": row.identity["source"], "environment": row.identity["environment"]}
                       for row in db.scalars(select(MarketDataset))]
            from .series_access import search
            sources += [{"id": row["ticker"], "symbol": row["symbol"], "source": row["source"],
                "environment": row["description"], "series_kind": row["series_kind"]} for row in search(db)]
        # The legacy workspace only supports numeric inputs and generic series.
        # Native profiles require the advanced host's controls and plot mapping.
        indicators = {name: meta for name, meta in public_catalog().items()
                      if not meta.get("render_profile")}
        return {"frames": FRAMES, "indicators": indicators, "managed_sources": sources}

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
        try:
            if body.instrument.startswith(("MWH:", "MWC:")):
                ident, kind = decode(body.instrument)
                if body.series_kind not in ("managed", kind):
                    raise ValueError("行情标识与指定类型不一致")
                body = body.model_copy(update={"instrument": ident, "series_kind": kind})
            if body.series_kind in ("history", "composite"):
                from .chart_series import encode
                from .series_access import export_page

                with transaction() as db:
                    page = export_page(db, body)
                if page.get("export_pending"):
                    raise HTTPException(409, "；".join(page["pending"]))
                return Response(chart_csv(page, instrument=encode(body.instrument, body.series_kind),
                        timeframe=body.timeframe), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": 'attachment; filename="market-watch.csv"',
                                 "Cache-Control": "no-store"})
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
            calendar = calendar_for(inst)
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
            from .history_retention import lock_reference_values

            try:
                lock_reference_values(db, body.document)
            except ValueError as error:
                raise HTTPException(409, str(error)) from None
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

    @r.get("/history-capabilities")
    def history_capabilities():
        from .provider_history_policy import capabilities
        return capabilities()

    @r.post("/history-capacity")
    def history_capacity(body: HistoryCapacityWrite):
        from .provider_history_policy import save_capacity
        try:
            return save_capacity(body.max_bars)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    async def history_operation(operation, *args):
        import httpx

        from .provider_history_policy import CapacityExceeded
        try:
            return await asyncio.to_thread(operation, *args)
        except CapacityExceeded as exc:
            raise HTTPException(422, {"code": exc.code, "message": str(exc), "history_boundary": False}) from None
        except TimeoutError:
            raise HTTPException(503, {"code": "HISTORY_TIMEOUT", "message": "历史读取超时，请重试", "history_boundary": False}) from None
        except httpx.HTTPError:
            raise HTTPException(503, {"code": "HISTORY_PROVIDER_FAILED", "message": "平台历史暂不可用，请重试", "history_boundary": False}) from None
        except ValueError as exc:
            raise HTTPException(422, {"code": "INVALID_HISTORY_REQUEST", "message": str(exc), "history_boundary": False}) from None

    @r.post("/history-loads")
    async def history_submit(body: HistoryLoadQuery, request: Request):
        from .native_history_loads import owner_of, submit
        return await history_operation(submit, owner_of(request), body.request_id, body.query)

    @r.get("/history-loads/{id}")
    async def history_status(id: str, request: Request):
        from .native_history_loads import owner_of, status
        return await history_operation(status, owner_of(request), id)

    @r.get("/history-loads/{id}/result")
    async def history_result(id: str, request: Request):
        from .native_history_loads import owner_of, result
        return await history_operation(result, owner_of(request), id)

    @r.post("/history-loads/{id}/cancel")
    async def history_cancel(id: str, request: Request):
        from .native_history_loads import owner_of, status
        return await history_operation(status, owner_of(request), id, True)

    @r.post("/reserve")
    async def reserve(body: DataQuery, request: Request):
        if body.native_reserve is None:
            raise HTTPException(422, "缺少图表储备上下文")
        return await data(body, request)

    @r.post("/data")
    async def data(body: DataQuery, request: Request):
        return await query_chart(body, request.is_disconnected)

    return r


def data_sync(body: DataQuery):
    try:
        ident, kind = decode(body.instrument) if body.instrument.startswith(("MWH:", "MWC:")) else (body.instrument, body.series_kind)
        if kind in ("history", "composite"):
            if body.series_kind not in ("managed", kind):
                raise ValueError("行情标识与指定类型不一致")
            body = body.model_copy(update={"instrument": ident, "series_kind": kind})
        for spec in body.indicators:
            validate(spec)
        if body.series_kind in ("history", "composite"):
            from .series_access import chart_data

            with transaction() as db:
                return chart_data(db, body)
        if body.series_kind == "provider":
            import httpx

            from .provider_chart import data as provider_data
            from .provider_dukascopy import NativeDataError
            from .provider_yahoo import YahooError

            try:
                return provider_data(body)
            except YahooError as error:
                raise HTTPException(503, {"message":str(error), "status":error.status,
                                          "history_boundary":False}) from None
            except NativeDataError as error:
                raise HTTPException(503, {"message": str(error), "status": error.status,
                                          "history_boundary": False}) from None
            except (httpx.HTTPError, TimeoutError) as error:
                raise HTTPException(503, "平台行情暂不可用，请重试；尚未确认历史边界") from error
        if body.published:
            return published_data(body)
        with transaction() as db:
            inst = db.get(Instrument, body.instrument)
            if not inst:
                raise HTTPException(404, "品种不存在")
            if body.client:
                from .market_data import renew_demand
                renew_demand(db, body.client, inst)
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
            stamp = db.execute(
                select(
                    func.count(Bar.id),
                    func.max(Bar.received_at),
                    func.sum(Bar.revision + Bar.volume_revision),
                    func.min(Bar.start),
                    func.max(Bar.start),
                ).where(Bar.instrument_id == inst.id, Bar.timeframe == source)
            ).one()
            revision = hashlib.sha256(
                json.dumps([list(stamp), inst.calendar_profile], sort_keys=True).encode()
            ).hexdigest()
            if not body.indicators:
                # Ordinary chart pagination must not materialize all available history.
                page = chart_rows(db, inst, body.timeframe, before, body.limit + 1, now_ms())
                visible = page[-body.limit :]
                return {
                    "history_check": history_check(db, inst, source, visible, body),
                    "history_revision": revision,
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
            dependency = history_check(db, inst, source, visible, body.model_copy(update={
                "indicators": [], "track_history": True, "revision_before": body.dependency_before,
                "revision_after": all_rows[0]["start"] if all_rows else 0})) if body.dependency_before else None
            # No lazy ORM reads during CPU work after returning the connection.
            db.expunge(inst)
        if not cache_hit:
            closures = closures_from(inst.calendar_profile)
            for prev, row in zip(all_rows, all_rows[1:]):
                if prev["end"] < row["start"]:
                    row["gap_before"] = bucket_has_trading(
                        instant(prev["end"]),
                        instant(row["start"]),
                        calendar_for(inst),
                        gold=is_gold(inst.id),
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
                body.provisional,
            )
            with _CACHE_LOCK:
                cached_result = _RESULT_CACHE.get(result_key)
            if cached_result and time.monotonic() - cached_result[0] < 15:
                result = cached_result[1]
            else:
                result = calculate(all_rows, spec, provisional=body.provisional)
                if "presentation" in result:
                    result["presentation"] = result["presentation"] | {
                        "history_revision": revision, "history_complete": True}
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
            "dependency_before": body.dependency_before,
            "dependency_revision": dependency["revision"] if dependency else None,
            "history_revision": revision,
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
        detail = {"code": e.code, "message": str(e)} if hasattr(e, "code") else str(e)
        raise HTTPException(422, detail) from e


async def query_chart(body: DataQuery, disconnected=None, deadline=None, retain_work=False):
    """One cancellable query path shared by browser and MCP adapters."""
    from .config import settings
    from .provider_cache import CANCELLED, DEADLINE

    cancelled = threading.Event()
    token = CANCELLED.set(cancelled)
    deadline = min(deadline or float("inf"), time.monotonic() + settings.provider_request_seconds)
    deadline_token = DEADLINE.set(deadline)
    task = asyncio.create_task(asyncio.to_thread(data_sync, body))
    try:
        while not task.done():
            if disconnected and await disconnected():
                cancelled.set()
                raise asyncio.CancelledError()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(503, "行情查询超过时间预算；尚未确认历史边界")
            await asyncio.wait({task}, timeout=min(0.05, remaining))
        return await task
    finally:
        cancelled.set()
        CANCELLED.reset(token)
        DEADLINE.reset(deadline_token)
        if not task.done():
            # MCP retains its compute slot while its transport returns a budget error.
            # Browser waiters keep the established immediate deadline response.
            if retain_work:
                try:
                    await asyncio.shield(task)
                except (Exception, asyncio.CancelledError):
                    pass
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
