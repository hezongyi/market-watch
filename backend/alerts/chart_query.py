"""Shared cancellable market query implementation, independent of transport."""

import asyncio
import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select

from .calendar_profile import closures_from
from .chart_data import chart_rows, future_grid
from .chart_history_plan import bucket_has_trading
from .chart_indicators import calculate, validate
from .chart_series import SeriesKind, decode, is_gold
from .domain import calendar_for
from .managed_dataset import data as published_data
from .query_errors import QueryError
from .storage import (
    Bar,
    Instrument,
    instant,
    now_ms,
    transaction,
)
from .volume import metadata as volume_metadata


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


class IndicatorConsumerReference(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1,max_length=100)
    generation: int = Field(ge=0,le=9007199254740991)


class IndicatorConsumer(IndicatorConsumerReference):
    spec: dict
    purpose: str = Field(default='foreground',pattern='^(foreground|warmup)$')


class ReleaseIndicatorConsumers(BaseModel):
    client: str = Field(min_length=1,max_length=64)
    consumers: list[IndicatorConsumerReference] = Field(max_length=64)


class IndicatorLease(BaseModel):
    run_id: str = Field(pattern='^[a-f0-9]{64}$')
    snapshot_id: str | None = Field(default=None,pattern='^[a-f0-9]{64}$')
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    consumer: IndicatorConsumer


class UpdateIndicatorLeases(BaseModel):
    client: str = Field(min_length=1,max_length=64)
    leases: list[IndicatorLease] = Field(max_length=64)


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
    indicator_consumers: list[IndicatorConsumer] = Field(default_factory=list,max_length=64)
    indicators: list[dict] = Field(default_factory=list, max_length=12)
    indicator_input_policy: Literal["strict_confirmed_v1", "observed_display_v1"] = "strict_confirmed_v1"
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
    display_snapshot_id: str | None = Field(default=None, min_length=64, max_length=64)
    provider_snapshot_id: str | None = Field(default=None, min_length=64, max_length=64, pattern=r"^[a-f0-9]+$")
    display_retry: dict[str, str] | None = Field(default=None, max_length=12)
    native_history: NativeHistory | None = None
    history_observation: HistoryObservation | None = None
    native_reserve: NativeReserve | None = None

    @model_validator(mode="after")
    def validate_display_retry(self):
        if self.display_retry is not None and (self.series_kind != 'composite' or
                not self.display_snapshot_id or not self.indicators or any(
                    not re.fullmatch(r'[a-f0-9]{64}', key) or not re.fullmatch(r'[a-f0-9]{64}', value)
                    for key, value in self.display_retry.items())):
            raise ValueError('展示任务重试须绑定组合快照、指标与故障凭据')
        return self

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
        if self.indicator_input_policy == "observed_display_v1":
            kind = decode(self.instrument)[1] if self.instrument.startswith(("MWH:", "MWC:")) else self.series_kind
            if kind not in ("history", "composite"):
                raise ValueError("observed_display_v1 requires history or composite chart inputs")
        if self.provider_snapshot_id is not None and (self.series_kind != "provider" or self.native_history is not None):
            raise ValueError("平台展示快照只适用于普通平台指标读取")
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






_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()
_RESULT_CACHE = OrderedDict()


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
            from .fixed_indicator_display import complete, prepare
            from .series_access import chart_data

            started = time.perf_counter()
            with transaction() as db:
                page = chart_data(db, body)
                prepared = prepare(db, page, body)
            page['timings_ms'] = {**page.get('timings_ms', {}), 'fixed_read_freeze':round((time.perf_counter()-started)*1000,2)}
            return complete(page, prepared)
        if body.series_kind == "provider":
            import httpx

            from .provider_chart import data as provider_data
            from .provider_dukascopy import NativeDataError
            from .provider_yahoo import YahooError

            try:
                return provider_data(body)
            except YahooError as error:
                raise QueryError(503, {"message":str(error), "status":error.status,
                                          "history_boundary":False}) from None
            except NativeDataError as error:
                raise QueryError(503, {"message": str(error), "status": error.status,
                                          "history_boundary": False}) from None
            except (httpx.HTTPError, TimeoutError) as error:
                raise QueryError(503, "平台行情暂不可用，请重试；尚未确认历史边界") from error
        if body.published:
            return published_data(body)
        with transaction() as db:
            if (body.indicators or body.dependency_before) and db.get_bind().dialect.name == "postgresql":
                db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            inst = db.get(Instrument, body.instrument)
            if not inst:
                raise QueryError(404, "品种不存在")
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
                from .chart_calculation_history import calculation_rows

                result = calculate(calculation_rows(all_rows, {"calendar": inst.calendar},
                    inst.id, body.timeframe), spec, provisional=body.provisional)
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
        if hasattr(e, "display_retry"):
            detail["display_retry"] = e.display_retry
        if hasattr(e, 'snapshot_evidence'):
            detail['snapshot_evidence'] = e.snapshot_evidence
        headers = {'X-MW-Attempt-Ref': e.attempt_ref} if hasattr(e, 'attempt_ref') else None
        raise QueryError(422, detail, headers=headers) from e


async def query_chart(body: DataQuery, disconnected=None, deadline=None, retain_work=False):
    """One cancellable query path shared by browser and MCP adapters."""
    from .provider_cache import CANCELLED, DEADLINE
    from .provider_capabilities import request_seconds

    cancelled = threading.Event()
    token = CANCELLED.set(cancelled)
    source = None
    if body.series_kind == "provider":
        ident = body.instrument.removeprefix("MWP:").upper()
        if ident.startswith("FXCM:"):
            source = "fxcm"
        elif ident.startswith(("AKSHARE:", "TENCENT:")):
            source = "akshare"
    deadline = min(deadline or float("inf"), time.monotonic() + request_seconds(source))
    deadline_token = DEADLINE.set(deadline)
    task = asyncio.create_task(asyncio.to_thread(data_sync, body))
    try:
        while not task.done():
            if disconnected and await disconnected():
                cancelled.set()
                raise asyncio.CancelledError()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise QueryError(503, "行情查询超过时间预算；尚未确认历史边界")
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
