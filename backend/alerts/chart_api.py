"""Authenticated chart APIs with optimistic concurrency and bounded input."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select

from .chart_data import FRAMES, chart_rows
from .chart_indicators import public_catalog, validate
from .chart_query import (
    DataQuery,
    ReleaseIndicatorConsumers,
    UpdateIndicatorLeases,
    data_sync,
    query_chart,
)
from .chart_series import SeriesKind, decode
from .domain import calendar_for
from .native_series import OandaParameters
from .storage import (
    ChartTemplate,
    instant,
    now_ms,
    transaction,
)


class Create(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class NativeConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instrument: str = Field(min_length=1, max_length=40)
    parameters: OandaParameters






class Template(Create):
    indicators: list[dict] = Field(max_length=12)


class HistoryLoadQuery(BaseModel):
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9._:-]+$")
    query: DataQuery
    notice_context: dict[str, str] = Field(default_factory=dict, max_length=2)

    @field_validator('notice_context')
    @classmethod
    def bounded_notice_context(cls, value):
        if any(key not in ('workspace_id', 'chart_index') or len(item) > 80 for key, item in value.items()):
            raise ValueError('无效图格通知上下文')
        return value


class HistoryCapacityWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    max_bars: int


class ExportQuery(BaseModel):
    notice_workspace: str = Field(default="", max_length=80)
    instrument: str = Field(max_length=80)
    series_kind: SeriesKind = "managed"
    published: bool = False
    timeframe: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    indicators: list[dict] = Field(default_factory=list, max_length=12)
    composite_revision_id: str | None = Field(default=None, max_length=36)
    input_revision: int | None = Field(default=None, ge=0)


def router(authenticated):
    r = APIRouter(prefix="/api/charts", dependencies=[Depends(authenticated)])

    @r.post('/indicator-demands/release')
    def release_indicator_consumers(body: ReleaseIndicatorConsumers):
        from .indicator_demands import release
        with transaction() as db:
            release(db,body.client,[consumer.model_dump() for consumer in body.consumers],stamp=now_ms())
        return {'released':True}

    @r.post('/indicator-demands/update')
    def update_indicator_leases(body: UpdateIndicatorLeases):
        from .indicator_demands import renew
        from .storage import DisplaySnapshot, FixedIndicatorRun
        with transaction() as db:
            stamp=now_ms()
            for lease in body.leases:
                run=db.get(FixedIndicatorRun,lease.run_id)
                if not run:
                    continue
                if lease.snapshot_id:
                    snapshot=db.get(DisplaySnapshot,lease.snapshot_id)
                    if not snapshot or snapshot.expires_at<=stamp or snapshot.revision_id!=run.revision_id or snapshot.timeframe!=run.timeframe:
                        continue
                renew(db,body.client,[lease.consumer.model_dump()],run,snapshot_id=lease.snapshot_id,
                    start=lease.start,end=lease.end,stamp=stamp)
        return {'renewed':True}

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
    @r.post("/provider/unsubscribe")
    @r.get("/provider/events")
    def retired_provider_stream():
        raise HTTPException(410, "供应商图表通道已更新，请重新加载页面")

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
                    from .notification_sources import chart_import_scope
                    chart_import_scope(db, jobs, {'workspace_id': body.notice_workspace, 'timeframe': body.timeframe, 'endpoint': '/charts/export'})
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

    @r.api_route("/workspaces", methods=["GET", "POST"])
    @r.api_route("/workspaces/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    def retired_workspace(path: str = ""):
        raise HTTPException(410, "兼容图表工作区已退役，历史文档保留；请使用 Advanced Charts")

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
        return await history_operation(submit, owner_of(request), body.request_id, body.query, body.notice_context)

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
        # Readers already return JSON primitives. A response avoids FastAPI's
        # second recursive conversion of every candle, segment and plot point.
        return JSONResponse(await query_chart(body, request.is_disconnected))

    return r
