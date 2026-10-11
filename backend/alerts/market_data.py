"""On-demand history orchestration. Datafeed requests never mean provider exhaustion."""

import time
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .calendar_profile import closures_from
from .chart_data import FRAMES, bounds, chart_rows
from .chart_series import SeriesKind, decode, is_gold
from .coverage import covers_interval
from .domain import (
    bucket_bounds,
    calendar_for,
    has_trading_gap,
    scheduled_open,
    session_bounds,
)
from .market import stored_coverage
from .market_calendar import session_status
from .market_names import chinese_name, display_code, matches_code, pair_query
from .providers import fetch_oanda_catalog
from .quote_presentation import describe, fixed_snapshot
from .storage import (
    Bar,
    ChartHistoryPlan,
    ImportJob,
    Instrument,
    MarketCatalog,
    MarketDataset,
    MarketDemand,
    WeeklyHistoryRequest,
    instant,
    ms,
    now_ms,
    transaction,
)
from .volume import metadata as volume_metadata

FRAME_MS = {
    "M1": 60000,
    "M5": 300000,
    "M15": 900000,
    "M30": 1800000,
    "H1": 3600000,
    "H4": 14400000,
    "D1": 86400000,
    "W1": 604800000,
    "MN": 2678400000,
}
DAY = 86400000


def refresh_catalog():
    items = fetch_oanda_catalog()
    with transaction() as db:
        for old in db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda",
                ~MarketCatalog.id.startswith("HC:"))):
            old.available = False
        for item in items:
            symbol = item["name"]
            ident = {"EUR_USD": "EURUSD", "XAU_USD": "XAUUSD"}.get(symbol, "OANDA:" + symbol)
            row = db.get(MarketCatalog, ident)
            if not row:
                row = MarketCatalog(id=ident, source="oanda", symbol=symbol)
                db.add(row)
            row.label = item.get("displayName", symbol)
            row.asset_type = item.get("type", "UNKNOWN")
            row.precision = item["displayPrecision"]
            row.calendar = "ny17" if row.asset_type == "CURRENCY" or symbol == "XAU_USD" else None
            row.updated_at = now_ms()
            row.available = True
    return len(items)


def resolve(db, ident):
    inst = db.get(Instrument, ident)
    entry = db.get(MarketCatalog, ident)
    if entry and entry.id.startswith("HC:"):
        raise HTTPException(422, "自建来源目录仅用于登记历史，不作为平台或实时身份")
    if entry and entry.source == "yahoo":
        raise HTTPException(422, "Yahoo 品种仅支持平台系列，不创建历史维护任务")
    if entry and not entry.available:
        raise HTTPException(422, "此品种已不在当前账户目录中，历史保留")
    if not inst:
        if not entry:
            raise HTTPException(404, "未知品种，请刷新品种目录")
        if not entry.calendar:
            raise HTTPException(422, "该资产的交易日历尚未接入")
        inst = Instrument(
            id=ident,
            label=entry.label,
            source=entry.source,
            symbol=entry.symbol,
            basis="bid",
            calendar=entry.calendar,
            precision=entry.precision,
            enabled=False,
            calendar_profile={},
        )
        db.add(inst)
        db.flush()
    if inst.source not in ("oanda", "binance"):
        raise HTTPException(422, "此品种尚未接入按需行情服务")
    return inst


def missing_intervals(coverage, left, right):
    cursor = left
    for span in sorted(coverage, key=lambda s: s["start"]):
        if span["end"] <= cursor:
            continue
        if span["start"] >= right:
            break
        if span["start"] > cursor:
            yield cursor, min(right, span["start"])
        cursor = max(cursor, span["end"])
    if cursor < right:
        yield cursor, right


def queue_history(db, inst, left, right, *, priority=100):
    from .storage import MarketDataset
    if db.scalar(select(MarketDataset.id).where(MarketDataset.instrument_id == inst.id)):
        raise HTTPException(422, "显式数据集由同源采集管理；历史演练请选择不可变 Dukascopy 版本")
    # Serialize planning per instrument; compatible with worker row locks.
    db.scalar(select(Instrument).where(Instrument.id == inst.id).with_for_update())
    coverage = stored_coverage(db, inst, left, right)
    jobs = list(
        db.scalars(
            select(ImportJob).where(
                ImportJob.instrument_id == inst.id,
                ImportJob.start < right,
                ImportJob.cursor < right,
                ImportJob.end > left,
                ImportJob.status.in_(["pending", "running", "failed"]),
            )
        )
    )
    for job in jobs:
        # Shared foreground demand promotes background work; later background
        # readers must never demote work required by a visible intraday chart.
        if job.priority >= 100:
            job.priority = min(job.priority, priority)
    reserved = coverage + [{"start": j.cursor, "end": j.end} for j in jobs]
    for a, b in missing_intervals(reserved, left, right):
        # Newest pages first. Cursor persistence makes every page restartable.
        end = b
        while end > a:
            start = max(a, end - 4000 * 60000)
            job = ImportJob(
                instrument_id=inst.id, start=start, end=end, cursor=start, priority=priority
            )
            db.add(job)
            jobs.append(job)
            end = start
    db.flush()
    return jobs, coverage


class HistoryQuery(BaseModel):
    instrument: str = Field(max_length=80)
    series_kind: SeriesKind = "managed"
    timeframe: str
    before: int | None = Field(default=None, gt=0)
    limit: int = Field(default=300, ge=1, le=2000)


class PlanControlQuery(BaseModel):
    instrument: str = Field(max_length=40)
    action: str


class MaintenanceQuery(BaseModel):
    instrument: str = Field(max_length=40)
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class DatasetQuery(BaseModel):
    instrument: str = Field(max_length=40)
    timeframe: str
    plot_width: float = Field(default=960, gt=0, le=16384)
    bar_spacing: float = Field(default=6, gt=0, le=1000)
    lookback: int = Field(default=0, ge=0, le=6000)
    indicators: list[dict] = Field(default_factory=list, max_length=12)


class ViewportDemandQuery(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9:_-]+$")
    instrument: str = Field(max_length=40)
    timeframe: str
    end: int = Field(gt=0)
    visible: int = Field(ge=1, le=2000)
    focused: bool = True
    required: int | None = Field(default=None, ge=1, le=6000)
    anchor_start: int | None = Field(default=None, gt=0)


class ViewportQuery(BaseModel):
    instrument: str = Field(max_length=80)
    start: int = Field(ge=0)
    end: int = Field(gt=0)


def viewport_session(inst, start, end):
    """Distinguish a scheduled closure from missing price history, using canonical calendar."""
    if not 0 < end - start <= 31 * DAY:
        raise HTTPException(422, "视区范围必须在31天以内")
    calendar = calendar_for(inst)
    closures = closures_from(inst.calendar_profile)
    options = dict(gold=is_gold(inst.id), closures=closures)
    if has_trading_gap(instant(start), instant(end), calendar, **options):
        return {"closed": False}
    # M1 is the finest supported chart granularity. Bound the backwards search.
    cursor = start // 60000 * 60000 - 60000
    for _ in range(31 * 24 * 60):
        if scheduled_open(instant(cursor), calendar, **options):
            return {"closed": True, "start": cursor + 60000 - (end - start),
                    "end": cursor + 60000}
        cursor -= 60000
    raise HTTPException(422, "未找到休市前交易时段")


class Activity(BaseModel):
    client: str = Field(min_length=1, max_length=40)
    instrument: str = Field(max_length=80)


class QuoteQuery(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=100)
    client: str | None = Field(default=None, min_length=1, max_length=40)
    composite_revision_id: str | None = Field(default=None, max_length=36)
    input_revision: int | None = Field(default=None, ge=0)


def demand_id(client, instrument_id, *, composite_revision_id=None):
    import hashlib

    lease_key = client + "|" + instrument_id
    if composite_revision_id is not None:
        lease_key += "|" + composite_revision_id
    return hashlib.sha256(lease_key.encode()).hexdigest()[:40]


def renew_demand(db, client, inst, *, composite_revision_id=None):
    # Searching/selecting/refusing an unmaintained managed series does not
    # authorize even a temporary M1 maintenance lease.
    plan = db.get(ChartHistoryPlan, inst.id)
    from .storage import CompositeRevision, MarketComposite, MarketDataset
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == inst.id))
    composite = db.scalar(select(MarketComposite).where(MarketComposite.instrument_id == inst.id))
    if composite_revision_id is not None:
        revision = db.get(CompositeRevision, composite_revision_id)
        if not composite or not revision or revision.composite_id != composite.id:
            raise ValueError("需求修订不属于所选组合行情")
    live_source = dataset and dataset.identity["source"] == "oanda"
    if not live_source and not composite and not inst.enabled and not (plan and plan.realtime_enabled):
        return
    ident = demand_id(client, inst.id, composite_revision_id=composite_revision_id)
    demand = db.get(MarketDemand, ident)
    if not demand:
        demand = MarketDemand(id=ident, instrument_id=inst.id, composite_revision_id=composite_revision_id)
        db.add(demand)
    demand.expires = now_ms() + 120000
    demand.updated_at = now_ms()


def read_cached_history(body: HistoryQuery):
    """Read observations without planning jobs or taking the instrument writer lock.

    Empty/short pages describe local availability, never provider exhaustion.
    Historical partial candles are excluded; a forming candle is usable only
    when its observed prefix is covered from the bucket's actual start.
    """
    if body.series_kind != "managed":
        raise HTTPException(422, "平台行情不读取自建覆盖或维护计划")
    if body.timeframe not in FRAMES:
        raise HTTPException(422, "不支持的周期")
    now = now_ms()
    before = min(body.before or now + 1, now + 1)
    cutoff = (now - 5000) // 60000 * 60000
    with transaction() as db:
        # Resolution/registration is a separate operation. Reads never create
        # instruments, so a truly cold symbol can return immediately.
        inst = db.get(Instrument, body.instrument)
        if inst is None:
            return {"bars": [], "coverage": [], "local_only": True,
                    "remote_boundary": "unknown", "next_cursor": None}
        if inst.source not in ("oanda", "binance"):
            raise HTTPException(422, "此品种尚未接入按需行情服务")
        rows = chart_rows(db, inst, body.timeframe, before, body.limit, now)
        left = rows[0]["start"] if rows else before
        coverage = stored_coverage(db, inst, left, max(before, cutoff)) if rows else []
        # A forming candle represents the latest persisted observation, not
        # a promise that the provider has delivered through this wall-clock minute.
        # Advancing time alone must not remove/reinsert its native series point.
        observed_end = db.scalar(select(func.max(Bar.end)).where(
            Bar.instrument_id == inst.id, Bar.timeframe == "M1",
            Bar.complete.is_(True), Bar.end <= cutoff)) if any(
                not row["complete"] for row in rows) else None
        usable = [row for row in rows if not row.get("pending_aggregation") and (row["complete"] or (
            observed_end is not None and row["start"] < observed_end <= cutoff < row["end"]
            and covers_interval(coverage, row["start"], observed_end)
        ))]
        # Return a contiguous observed suffix. Do not join cached islands across
        # a trading interval whose provider coverage has not been established.
        contiguous = []
        calendar = calendar_for(inst)
        closures = closures_from(inst.calendar_profile)
        for row in reversed(usable):
            if contiguous:
                right = contiguous[-1]["start"]
                gaps = missing_intervals(coverage, row["end"], right)
                if any(has_trading_gap(instant(a), instant(b), calendar,
                                       gold=is_gold(inst.id), closures=closures)
                       for a, b in gaps):
                    break
            contiguous.append(row)
        contiguous.reverse()
        return {
            "bars": contiguous,
            "coverage": coverage,
            "local_only": True,
            "remote_boundary": "unknown",
            # Advance across rejected partial rows without claiming no history.
            "next_cursor": rows[0]["start"] if rows else None,
        }


def plan_history(body: HistoryQuery):
    if body.series_kind != "managed":
        raise HTTPException(422, "平台行情不创建自建历史任务")
    if body.timeframe not in FRAMES:
        raise HTTPException(422, "不支持的周期")
    right = min(body.before or now_ms(), (now_ms() - 5000) // 60000 * 60000)
    # Count is a preference, not a reason to eagerly download decades of M1.
    span = min(31 * DAY, max(2 * DAY, int(FRAME_MS[body.timeframe] * body.limit * 1.5)))
    left = max(0, right - span)
    with transaction() as db:
        inst = resolve(db, body.instrument)
        calendar = calendar_for(inst)
        if body.timeframe == "MN":
            # Monthly charts are an explicit cache-only view. Opening one
            # must not plan dedicated M1 downloads, even for a large countBack.
            rows = chart_rows(db, inst, "MN", body.before or now_ms() + 1, body.limit, now_ms())
            return {
                "status": "ready" if rows else "empty_interval",
                "bars": rows,
                "task_ids": [],
                "failed_task_ids": [],
                "error": None,
                "retry_after": 0,
                "queue_class": "cache_only",
                "local_only": True,
                "estimated_seconds": None,
                "requested_start": 0,
                "requested_end": right,
                "next_cursor": rows[0]["start"] if rows else 0,
                "remote_boundary": "unknown",
            }
        if body.timeframe in ("M30", "W1", "MN"):
            left = ms(bounds(instant(left), body.timeframe, calendar)[0])
        else:
            left = ms(bucket_bounds(instant(left), body.timeframe, calendar)[0])
        rows = chart_rows(
            db, inst, body.timeframe, body.before or now_ms() + 1, body.limit, now_ms()
        )
        # A cached range satisfies the request only when upstream query coverage is known.
        if len(rows) >= body.limit:
            left = max(left, rows[0]["start"])
        background = body.timeframe == "W1"
        scheduling = {"priority": 200} if background else {}
        jobs, coverage = queue_history(db, inst, left, right, **scheduling)
        # Coverage and bars must be observed in this order: a worker may commit
        # between the preliminary cache lookup and acquiring the planner lock.
        rows = chart_rows(
            db, inst, body.timeframe, body.before or now_ms() + 1, body.limit, now_ms()
        )
        # A fully queried short/empty window does not satisfy countBack.
        # Expand deterministically from the original request, so repeated polls
        # finish missing pages without walking backwards forever. Stop as soon
        # as a page needs fetching; the next poll will reconsider its result.
        for _ in range(3):
            if (
                len(rows) >= body.limit
                or not covers_interval(coverage, left, right)
                or left <= 0
            ):
                break
            candidate = max(0, left - span)
            if body.timeframe in ("M30", "W1", "MN"):
                left = ms(bounds(instant(candidate), body.timeframe, calendar)[0])
            else:
                left = ms(bucket_bounds(instant(candidate), body.timeframe, calendar)[0])
            left = max(0, left)
            jobs, coverage = queue_history(db, inst, left, right, **scheduling)
            rows = chart_rows(
                db, inst, body.timeframe, body.before or now_ms() + 1, body.limit, now_ms()
            )
        errors = [
            (j.error or "").strip() or "历史补数任务失败，未记录具体原因；请重试"
            for j in jobs if j.status == "failed"
        ]
        pending = [j for j in jobs if j.status in ("pending", "running")]
        complete = covers_interval(coverage, left, right)
        status = (
            "error"
            if errors and not complete
            else "pending"
            if not complete
            else "ready"
            if rows
            else "empty_interval"
        )
        return {
            "status": status,
            "bars": rows,
            "task_ids": [j.id for j in pending],
            "failed_task_ids": [
                j.id for j in jobs if j.status == "failed" and j.priority >= 100
            ],
            "error": errors[0] if errors else None,
            "retry_after": 5 if background else 2,
            "queue_class": "background" if background else "foreground",
            "estimated_seconds": None,
            "requested_start": left,
            "requested_end": right,
            "next_cursor": left,
            "remote_boundary": "unknown",
            "has_more_local": bool(
                rows
                and db.scalar(
                    select(Bar.id)
                    .where(
                        Bar.instrument_id == inst.id,
                        Bar.timeframe == "M1",
                        Bar.start < rows[0]["start"],
                    )
                    .limit(1)
                )
            ),
            "progress": {
                "completed_ms": sum(b - a for a, b in missing_intervals([], left, right))
                - sum(b - a for a, b in missing_intervals(coverage, left, right)),
                "total_ms": right - left,
            },
        }


def remember_weekly_request(body, end):
    """Persist the requested count and cursor, not just the first planning window."""
    import hashlib

    ident = hashlib.sha256(f"{body.instrument}|{end}|{body.limit}".encode()).hexdigest()[:40]
    with transaction() as db:
        # Match the instrument lock used by queue_history to serialize duplicate tabs.
        db.scalar(select(Instrument).where(Instrument.id == body.instrument).with_for_update())
        if not db.get(WeeklyHistoryRequest, ident):
            db.add(WeeklyHistoryRequest(id=ident, instrument_id=body.instrument,
                before=end, cursor=end, remaining=body.limit, next_at=now_ms()))


def advance_weekly_request():
    """Advance one durable request per maintenance cycle; imports stay priority 200."""
    with transaction() as db:
        row = db.scalar(select(WeeklyHistoryRequest)
            .where(WeeklyHistoryRequest.status == "pending", WeeklyHistoryRequest.next_at <= now_ms())
            .order_by(WeeklyHistoryRequest.next_at, WeeklyHistoryRequest.id)
            .with_for_update(skip_locked=True).limit(1))
        if not row:
            return False
        ident, cursor, remaining = row.id, row.cursor, row.remaining
        query = HistoryQuery(instrument=row.instrument_id, timeframe="W1", before=cursor, limit=remaining)
        row.next_at = now_ms() + 30000
    result = plan_history(query)
    with transaction() as db:
        row = db.get(WeeklyHistoryRequest, ident, with_for_update=True)
        if row.cursor != cursor or row.remaining != remaining:
            return True
        if result["status"] in ("ready", "empty_interval"):
            bars = [bar for bar in result["bars"]
                    if result["requested_start"] <= bar["start"] < cursor]
            if not bars:
                # A fully queried planning window (including bounded expansion)
                # with no usable weeks is not proof of the provider's inception.
                # Stop this durable request for inspection rather than sweeping
                # indefinitely back to 1970 while the user is away.
                row.status = "needs_review"
                return True
            row.remaining = max(0, remaining - len(bars))
            next_cursor = min((bar["start"] for bar in bars), default=result["next_cursor"])
            if row.remaining == 0:
                row.status = "complete"
            elif next_cursor < cursor and next_cursor > 0:
                row.cursor = next_cursor
            else:
                # No invented upstream exhaustion; retain an inspectable failure.
                row.status = "failed"
        # A failed ImportJob remains reserved. Periodic reconsideration resumes
        # only after an explicit retry fixes it, without creating duplicate work.
    return True


class VolumeStartQuery(BaseModel):
    instrument: str
    start: int | None = None
    end: int | None = None


class VolumeControlQuery(BaseModel):
    id: str
    action: str


def router(authenticated):
    r = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @r.get("/series/search")
    def series_search(query: str = "", kind: str = "all", limit: int = 100,
                      source: str | None = None, calendar: str | None = None):
        return search_series(query, kind=kind, limit=limit, source=source or None, calendar=calendar or None)

    @r.get("/series/page")
    def series_page(query: str = "", kind: str = "history", page_size: int = 25,
                    offset: int = 0, source: str | None = None, calendar: str | None = None,
                    symbol_type: str = "", cursor: str | None = None):
        return search_series_page(query, kind=kind, page_size=page_size, offset=offset,
                                  source=source or None, calendar=calendar or None, symbol_type=symbol_type, cursor=cursor)

    @r.post("/quotes")
    def quotes(body: QuoteQuery):
        return quote_snapshot(body)

    @r.get("/catalog")
    def catalog(query: str = ""):
        return instrument_catalog(query)

    @r.post("/catalog/refresh")
    def sync_catalog():
        return {"count": refresh_catalog()}

    @r.post("/resolve")
    def symbol(body: HistoryQuery):
        if body.series_kind == "provider":
            from .provider_chart import metadata

            return metadata(body.instrument)
        if body.series_kind in ("history", "composite"):
            from .series_access import metadata
            with transaction() as db:
                try:
                    return metadata(db, body.instrument, body.series_kind)
                except ValueError as error:
                    raise HTTPException(422, str(error)) from None
        with transaction() as db:
            inst = resolve(db, body.instrument)
            return {
                "id": inst.id,
                "name": inst.label,
                "symbol": inst.symbol,
                "display_symbol": display_code(inst.symbol, inst.source),
                "source": inst.source,
                "basis": inst.basis,
                "precision": inst.precision,
                "calendar": inst.calendar,
                "frames": FRAMES,
                **volume_metadata(inst.source, inst.symbol),
            }

    @r.post("/viewport-session")
    def viewport(body: ViewportQuery):
        with transaction() as db:
            return viewport_session(resolve(db, body.instrument), body.start, body.end)

    @r.post("/activity")
    def activity(body: Activity):
        with transaction() as db:
            ident, kind = decode(body.instrument)
            if kind == "history":
                return {"ok": True}
            if kind == "composite":
                from .series_access import composite_definition
                _, _, composite = composite_definition(db, ident)
                if composite:
                    renew_demand(db, body.client, db.get(Instrument, composite.instrument_id))
                return {"ok": True}
            inst = resolve(db, body.instrument)
            renew_demand(db, body.client, inst)
        return {"ok": True}

    @r.get("/history/plans")
    def history_plans():
        from .chart_history_plan import plan_status
        with transaction() as db:
            return [plan_status(db, plan, now_ms()) for plan in db.scalars(
                select(ChartHistoryPlan).order_by(ChartHistoryPlan.updated_at.desc()).limit(100))]

    @r.get("/history/volume")
    def volume_listing():
        from .storage import VolumeBackfillJob
        from .volume_jobs import describe
        with transaction() as db:
            return [describe(db, j) for j in db.scalars(select(VolumeBackfillJob)
                .order_by(VolumeBackfillJob.created_at.desc()).limit(100))]

    @r.get("/history/volume/{ident}/segments")
    def volume_segments(ident: str, offset: int = 0, limit: int = 100):
        from .storage import VolumeBackfillSegment
        if offset < 0 or not 1 <= limit <= 200:
            raise HTTPException(422, "无效分页")
        with transaction() as db:
            return [dict(start=s.start, end=s.end, status=s.status, detail=s.detail)
                for s in db.scalars(select(VolumeBackfillSegment).where(
                    VolumeBackfillSegment.job_id == ident).order_by(VolumeBackfillSegment.start.desc())
                    .offset(offset).limit(limit))]

    @r.post("/history/volume/start")
    def volume_start(body: VolumeStartQuery):
        from .volume_jobs import create, describe
        with transaction() as db:
            try:
                resolve(db, body.instrument)
                return describe(db, create(db, body.instrument, start=body.start, end=body.end))
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc

    @r.post("/history/volume/control")
    def volume_control(body: VolumeControlQuery):
        from .volume_jobs import control, describe
        with transaction() as db:
            try:
                return describe(db, control(db, body.id, body.action))
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc

    @r.post("/maintenance")
    def maintenance(body: MaintenanceQuery):
        import httpx

        from .chart_history_plan import plan_status, record_boundary
        from .managed_dataset import date_start, join
        from .provider_chart import earliest_m1

        with transaction() as db:
            inst = resolve(db, body.instrument)
            try:
                start = date_start(inst, body.start_date)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            meta = dict(id=inst.id, source=inst.source, symbol=inst.symbol, basis=inst.basis)
        # Release the pool connection before querying the provider's real first
        # M1. Reject unreachable requests without shifting the approved start.
        try:
            earliest = earliest_m1(meta)
        except (httpx.HTTPError, TimeoutError, ValueError) as error:
            raise HTTPException(503, "尚未确认最早可用历史，未建立维护任务，请稍后重试") from error
        if start < earliest:
            raise HTTPException(422, f"历史起点不可达：该品种最早可用M1为 {instant(earliest).isoformat()}；请明确选择可达起点，原维护范围保持不变")
        with transaction() as db:
            inst = resolve(db, body.instrument)
            existing = db.get(ChartHistoryPlan, inst.id)
            if existing and existing.target_start < earliest:
                record_boundary(db, inst, existing.target_start, earliest, now_ms())
            try:
                plan = join(db, inst, start, now_ms())
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            record_boundary(db, inst, plan.target_start, earliest, now_ms())
            return {**plan_status(db, plan, now_ms()), "calendar": inst.calendar}

    @r.post("/dataset")
    def dataset(body: DatasetQuery):
        from .managed_dataset import status

        with transaction() as db:
            inst = resolve(db, body.instrument)
            try:
                from .chart_indicators import history_requirement
                lookback = max([body.lookback] + [history_requirement(s) for s in body.indicators])
                return status(db, inst, body.timeframe, width=body.plot_width,
                              spacing=body.bar_spacing, lookback=lookback)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error

    @r.post("/history/plans/control")
    def history_plan_control(body: PlanControlQuery):
        from .chart_history_plan import control_plan
        with transaction() as db:
            try:
                plan = control_plan(db,body.instrument,body.action,now_ms())
            except ValueError as error:
                raise HTTPException(422,str(error)) from error
            return {"status":plan.status}

    @r.post("/history/demand")
    def viewport_demand(body: ViewportDemandQuery):
        from .chart_history_plan import history_end, update_demand
        from .storage import ChartAggregationJob

        now = now_ms()
        with transaction() as db:
            inst = resolve(db, body.instrument)
            try:
                end = body.end
                required = body.required
                if body.anchor_start is not None:
                    if body.anchor_start >= body.end:
                        raise ValueError("Invalid historical navigation interval")
                    required = min(2000, body.visible * 3)
                    end = min(end, history_end(inst, body.timeframe, body.anchor_start, required))
                end = min(end, (now - 5000) // 60000 * 60000)
                plan = update_demand(db, ident=body.id, instrument=body.instrument,
                    timeframe=body.timeframe, end=end,
                    visible=body.visible, focused=body.focused, now=now, required=required)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            if plan is None:
                return {"status": "unmaintained", "timeframe": body.timeframe}
            window_start = max(plan.target_start, body.anchor_start or plan.target_start)
            window_error = None
            if body.anchor_start is not None:
                failed = db.scalar(select(ImportJob.id).where(
                    ImportJob.instrument_id == inst.id, ImportJob.status == 'failed',
                    ImportJob.cursor < end, ImportJob.end > window_start).limit(1))
                aggregate_failed = db.scalar(select(ChartAggregationJob.id).where(
                    ChartAggregationJob.instrument_id == inst.id,
                    ChartAggregationJob.timeframe == ('M15' if body.timeframe == 'M30' else body.timeframe),
                    ChartAggregationJob.attempts >= 5,
                    ChartAggregationJob.start < end, ChartAggregationJob.end > window_start).limit(1))
                if failed or aggregate_failed:
                    window_error = '目标日期数据处理失败，请在历史任务中重试'
            return {"target_start": plan.target_start, "target_end": plan.target_end,
                    "status": plan.status, "window_end": end,
                    "window_start": window_start, "window_error": window_error,
                    "timeframe": body.timeframe}

    @r.post("/history/cache")
    def cached_history(body: HistoryQuery):
        return read_cached_history(body)

    @r.post("/history")
    def history(body: HistoryQuery):
        result = plan_history(body)
        if body.timeframe == "W1" and result["status"] == "pending":
            remember_weekly_request(body, result["requested_end"])
        return result

    @r.post("/retry/{ident}")
    def retry(ident: str):
        with transaction() as db:
            job = db.get(ImportJob, ident)
            if not job or job.priority < 100:
                raise HTTPException(404, "图表任务不存在")
            if job.status == "failed":
                job.status = "pending"
                job.attempts = 0
                job.next_at = now_ms()
                job.error = None
        return {"ok": True}

    return r


def search_series_page(query="", *, kind="history", page_size=25, offset=0, source=None, calendar=None, symbol_type="", cursor=None):
    from .search_types import TYPES
    if (kind not in ("all", "provider", "history", "composite") or symbol_type not in TYPES
            or not 1 <= page_size <= 250 or not 0 <= offset <= 1000000
            or source not in (None, "dukascopy", "oanda", "binance", "yahoo")
            or calendar not in (None, "ny17", "utc0")):
        raise HTTPException(422, "无效行情搜索分页或筛选")
    if kind == "all":
        if offset:
            raise HTTPException(422, "全类别搜索请使用游标翻页")
        return _all_series_page(query, page_size=page_size, source=source, calendar=calendar,
                                symbol_type=symbol_type, cursor=cursor)
    if cursor:
        raise HTTPException(422, "此搜索范围不接受游标")
    if kind == "provider":
        if calendar:
            raise HTTPException(422, "平台搜索不接受自建聚合日界")
        rows = _provider_series(query, source=source, symbol_type=symbol_type)
        items = rows[offset:offset + page_size]
        has_more = offset + len(items) < len(rows)
        return {"items": items, "total": len(rows), "offset": offset, "page_size": page_size,
            "has_more": has_more, "next_offset": offset + len(items) if has_more else None}
    from .series_access import search_page
    if source == "yahoo":
        return {"items": [], "has_more": False, "next_offset": None}
    try:
        with transaction() as db:
            return search_page(db, query, kind=kind, page_size=page_size, offset=offset,
                               source=source, calendar=calendar, symbol_type=symbol_type)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


def _all_series_page(query, *, page_size, source, calendar, symbol_type, cursor):
    """Fair merge of three pure searches. Cursor advances through candidates,
    including invalid mappings, without losing the unconsumed part of a page.
    Each managed branch retains its bounded qualification scan.
    """
    import base64
    import binascii
    import hashlib
    import json

    from .series_access import search_page

    signature = hashlib.sha256(json.dumps([query, source, calendar, symbol_type]).encode()).hexdigest()[:16]
    positions, turn = [0, 0, 0], 0
    if cursor:
        try:
            if len(cursor) > 300:
                raise ValueError()
            state = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
            positions, turn = state["p"], state["t"]
            if (state["s"] != signature or len(positions) != 3 or type(turn) is not int or not 0 <= turn < 3
                    or any(p is not None and (type(p) is not int or not 0 <= p <= 1000000) for p in positions)):
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError, binascii.Error):
            raise HTTPException(422, "无效搜索游标") from None
    providers = _provider_series(query, source=source, symbol_type=symbol_type) if positions[0] is not None and not calendar else []
    p = positions[0] or 0
    pages = [{"items": providers[p:p + page_size], "item_offsets": list(range(p + 1, min(p + page_size, len(providers)) + 1)),
              "next_offset": p + page_size if p + page_size < len(providers) else None}]
    with transaction() as db:
        for i, kind in enumerate(("history", "composite"), 1):
            pages.append(search_page(db, query, kind=kind, page_size=page_size, offset=positions[i],
                         source=source, calendar=calendar, symbol_type=symbol_type)
                         if positions[i] is not None and source != "yahoo" else {"items": [], "next_offset": None})
    for i, page in enumerate(pages):
        if not page["items"]:
            positions[i] = page["next_offset"]
    indices, items = [0, 0, 0], []
    for _ in range(page_size * 3):
        i = turn
        turn = (turn + 1) % 3
        page = pages[i]
        if indices[i] < len(page["items"]):
            items.append(page["items"][indices[i]])
            positions[i] = page["item_offsets"][indices[i]]
            indices[i] += 1
        if indices[i] == len(page["items"]):
            positions[i] = page["next_offset"]
        if len(items) == page_size or all(indices[j] == len(pages[j]["items"]) for j in range(3)):
            break
    has_more = any(p is not None for p in positions)
    next_cursor = base64.urlsafe_b64encode(json.dumps({"p": positions, "t": turn, "s": signature}, separators=(",", ":")).encode()).decode().rstrip("=") if has_more else None
    return {"items": items, "has_more": has_more, "next_cursor": next_cursor}


def _provider_series(query, *, source=None, symbol_type=""):
    from .chart_series import encode
    from .history_catalog import account_scope

    if source not in (None, "dukascopy", "oanda", "binance", "yahoo"):
        raise HTTPException(422, "未知平台来源")
    result = [{**row, "series_kind": "provider", "ticker": encode(row["id"], "provider"),
        "description": "平台 · " + row["source"] + " · 原生周期"}
        for row in instrument_catalog(query, limit=None) if not row["id"].startswith("MD:")]
    with transaction() as db:
        for row in db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda",
                MarketCatalog.id.startswith("HC:"), MarketCatalog.available.is_(True))):
            if row.metadata_json.get("history_account_scope") != account_scope():
                continue
            if not matches_code(query, row.symbol, row.source, row.asset_type, row.label):
                continue
            ident = "OANDA:" + row.symbol
            if any(item["id"] == ident for item in result):
                continue
            result.append({"id": ident, "symbol": row.symbol, "label": row.label,
                "display_symbol": display_code(row.symbol, row.source, row.asset_type),
                "series_kind": "provider", "ticker": encode(ident, "provider"),
                "source": "oanda", "asset_type": row.asset_type, "available": True,
                "supported": row.calendar in ("ny17", "utc0"), "precision": row.precision,
                "description": "平台 · OANDA Practice · Bid · 原生周期"})
    from .search_types import symbol_type as asset_type
    for row in result:
        row["type"] = asset_type(row.get("asset_type", ""))
    return _rank_catalog([row for row in result if (not source or row["source"] == source) and (not symbol_type or row["type"] == symbol_type)], query)


def search_series(query="", *, kind="all", limit=100, source=None, calendar=None):
    if kind not in ("all", "provider", "history", "composite") or not 1 <= limit <= 250:
        raise HTTPException(422, "无效行情搜索范围")
    if kind != "all":
        return search_series_page(query, kind=kind, page_size=limit, source=source, calendar=calendar)["items"]
    if source or calendar:
        raise HTTPException(422, "筛选请明确平台、自建或组合范围")
    from itertools import zip_longest

    from .series_access import search_page
    providers = _provider_series(query)
    with transaction() as db:
        histories = search_page(db, query, kind="history", page_size=limit)["items"]
        composites = search_page(db, query, kind="composite", page_size=limit)["items"]
    result = [row for group in zip_longest(providers, histories, composites) for row in group if row]
    return result[:limit]


def _rank_catalog(rows, query):
    """Prefer code matches; interleave equal-ranked sources to avoid starvation."""
    from collections import defaultdict

    term = (pair_query(query) or query.strip()).casefold()
    groups = defaultdict(lambda: defaultdict(list))
    for row in rows:
        row["display_symbol"] = display_code(row["symbol"], row["source"], row.get("asset_type"))
        codes = [row["display_symbol"].casefold(), row["display_symbol"].replace("/", "").casefold(), row.get("symbol", "").casefold(), row.get("logical_symbol", "").casefold(),
                 row.get("symbol", "").replace("_", "").replace("/", "").replace("-", "").casefold()]
        rank = 0 if term and term in codes else 1 if term and any(c.startswith(term) for c in codes) else 2
        groups[rank][row["source"]].append(row)
    result = []
    for rank in sorted(groups):
        sources = groups[rank]
        for index in range(max(map(len, sources.values()))):
            for rows in sources.values():
                if index < len(rows):
                    result.append(rows[index])
    return result


def instrument_catalog(query: str = "", *, limit=250):
    from .config import settings
    from .provider_dukascopy import catalog as dukascopy_catalog
    from .yahoo_catalog import search, seed
    seed()
    dukascopy = dukascopy_catalog(query)
    search_status = "local"
    if query.strip() and settings.yahoo_enabled:
        # Exact codes/names and known Chinese aliases remain local. A
        # Latin substring (GS in ^GSPC, MS in MSFT) cannot rule out a new ticker.
        term = pair_query(query) or query.strip().upper()
        with transaction() as db:
            local = list(db.scalars(select(MarketCatalog).where(~MarketCatalog.id.startswith("HC:")))) + list(db.scalars(select(Instrument)))
            known = any(term in {row["symbol"].upper(), row["logical_symbol"], row["display_symbol"]}
                        for row in dukascopy) or any(
                term in {x.symbol.upper(), x.label.upper(), display_code(x.symbol, x.source,
                         getattr(x, "asset_type", None)),
                         display_code(x.symbol, x.source, getattr(x, "asset_type", None)).replace("/", ""),
                         (getattr(x, "metadata_json", None) or {}).get("english_name", "").upper()}
                or not term.isascii() and term in
                (x.label + (chinese_name(x.source, x.symbol) or "")).upper()
                for x in local
            )
        if not known:
            search_status = search(query)
    with transaction() as db:
        entries = {
            x.id: {
                "id": x.id,
                "symbol": x.symbol,
                "label": x.label,
                "source": x.source,
                "asset_type": x.asset_type,
                "precision": x.precision,
                "supported": bool(x.calendar),
                "available": x.available and (x.source != "yahoo" or settings.yahoo_enabled),
                "series_kinds": ["provider"] if x.source == "yahoo" else ["provider", "managed"],
                "english_name": (x.metadata_json or {}).get("english_name", ""),
                "exchange": (x.metadata_json or {}).get("exchange"),
                "currency": (x.metadata_json or {}).get("currency"),
                "search_status": search_status,
            }
            for x in db.scalars(select(MarketCatalog).where(~MarketCatalog.id.startswith("HC:")))
        }
        for inst in db.scalars(
            select(Instrument).where(Instrument.source.in_(["oanda", "binance"]))
        ):
            entries.setdefault(
                inst.id,
                {
                    "id": inst.id,
                    "symbol": inst.symbol,
                    "label": inst.label,
                    "source": inst.source,
                    "asset_type": "CRYPTO" if inst.source == "binance" else "CURRENCY",
                    "series_kinds": ["provider", "managed"],
                    "precision": inst.precision,
                    "supported": True,
                    "available": True,
                },
            )
        from .storage import ChartPublication
        plans = {p.instrument_id: p for p in db.scalars(select(ChartHistoryPlan))}
        published = {p.instrument_id for p in db.scalars(select(ChartPublication).where(
            ChartPublication.complete_count > 0))}
        failures = set(db.scalars(select(ImportJob.instrument_id).where(
            ImportJob.chart_plan.is_(True), ImportJob.status == 'failed')))
        for entry in entries.values():
            localized = chinese_name(entry['source'], entry['symbol'])
            entry['chinese_name'] = localized or ''
            if localized:
                entry['english_name'] = entry.get('english_name') or entry['label']
                entry['label'] = localized
            plan = plans.get(entry['id'])
            entry['managed_status'] = ('未维护' if plan is None else
                '失败，已发布历史保留' if entry['id'] in failures else
                '部分已发布，范围见历史任务' if entry['id'] in published else '处理中')
        result = [
            x
            for x in entries.values()
            if x["available"] and matches_code(query, x["symbol"], x["source"],
                x["asset_type"], x["id"], x["label"], x.get("english_name", ""))
        ]
    for row in dukascopy:
        row["search_status"] = search_status
    return _rank_catalog(result + dukascopy, query)[:limit]


def _session_observation(source, symbol, session, event_at, metadata, *, event_end=None):
    """Flag a source observation that falls inside a reviewed closure.

    A conflict is diagnostic only: the price remains visible and the current
    session state is not replaced by a missing-data assumption. Evaluate the
    observation time independently; boundary minutes remain legal observations.
    """
    if event_at is None:
        return {}
    observed = session_status(source, symbol, event_at, metadata=metadata)
    probes = [event_at - 1]
    if event_end is not None:
        probes.extend((event_end - 1, event_end))
    if observed.get("market_session") == "closed" and all(
        session_status(source, symbol, at, metadata=metadata).get("market_session") == "closed"
        for at in probes
    ):
        return {"session_conflict": True,
                "session_conflict_reason": "时段与行情不一致，待核实"}
    return {}


def quote_snapshot(body: QuoteQuery):
    result = []
    # Fetch platform quotes before opening the managed read transaction.
    # Platform watchlists never renew managed M1 demand.
    managed = []
    for ticker in dict.fromkeys(body.symbols):
        try:
            ident, kind = decode(ticker)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        if kind == "managed":
            managed.append(ident)
            continue
        if kind in ("history", "composite"):
            from .series_access import metadata
            with transaction() as db:
                try:
                    meta = metadata(db, ident, kind)
                    shown = (meta.get("display_symbol") or display_code(meta["symbol"], meta["source"], meta.get("asset_type")))
                    values = {"short_name": shown, "description": meta["name"] + (
                        " · 固定历史" if kind == "history" else " · 组合行情"), "exchange": meta["source"].upper()}
                    facts = None
                    if kind == "history":
                        values.update(fixed_snapshot(db, ident, meta))
                    if kind == "composite":
                        from .composite_quotes import snapshot
                        from .series_access import composite_definition

                        _, _, composite = composite_definition(db, ident)
                        if composite:
                            facts = snapshot(db, composite, revision_id=body.composite_revision_id,
                                             input_revision=body.input_revision)
                            if facts["price"] is not None:
                                values["lp"] = float(facts["price"])
                                if facts["price_type"] == "sampled_bid":
                                    values["bid"] = values["lp"]
                            precise = facts["price_type"] == "sampled_bid"
                            provenance = facts.get("provenance") or {}
                            values.update(quote_time=facts["observed_at"] if precise else None,
                                data_start=None if precise else provenance.get("start"),
                                data_end=None if precise else provenance.get("end"),
                                time_type="composite_snapshot", observation_type="provider_quote" if precise else "source_m1",
                                price_type=facts["price_type"], quote_ready=facts["quote_ready"],
                                confirmed_tail_ready=facts["confirmed_tail_ready"], quality=facts["quality"],
                                **{key: facts.get(key) for key in ("market_session", "session_reason", "calendar_verified",
                                    "calendar_version", "read_at", "revision_id", "input_revision", "source_identity",
                                    "session_conflict", "session_conflict_reason", "fetch_status")})
                            values["description"] += " · " + ("抽样Bid" if facts["price_type"] == "sampled_bid" else
                                "保存的确认M1收盘" if facts["price"] is not None else "等待报价")

                    # Watchlist metadata is pure, never a first-use command.
                    result.append({"s": "ok", "n": ticker, "v": values,
                                   **({"snapshot": facts} if facts else {})})
                except ValueError:
                    result.append({"s": "error", "n": ticker, "v": {"description": "行情不可用，请查看数据中心"}})
            continue
        from .provider_chart import metadata, quote_page, quote_previous_close

        meta = None
        try:
            from .config import settings
            deadline = time.monotonic() + settings.provider_request_seconds
            meta = metadata(ident, deadline=deadline) if ident.startswith("YAHOO:") else metadata(ident)
            shown = (meta.get("display_symbol") or display_code(meta["symbol"], meta["source"], meta.get("asset_type")))
            if meta["source"] == "yahoo":
                from .provider_service import yahoo_quote
                snapshot = yahoo_quote(meta, deadline=deadline)
                stamp = snapshot["quote_time"]
                delay = snapshot["delay_seconds"]
                read_at = now_ms()
                session = session_status(meta["source"], meta["symbol"], now_ms(), metadata=meta)
                description = meta["name"] + " · Yahoo 市场报价"

                description += " · 延迟 " + str(delay//60) + " 分钟" if delay is not None and delay>0 else " · 延迟未知" if delay is None else " · 实时"
                conflict = _session_observation(meta["source"], meta["symbol"], session, stamp, meta)
                values = {"short_name":shown, "description":description,
                          "exchange":meta["exchange"], "lp":float(snapshot["price"]),
                          "quote_time":stamp, "fetched_at":snapshot["fetched_at"],
                          "read_at":read_at, "time_type": "provider_quote" if stamp is not None else None,
                          "delay_seconds":delay, "fetch_status":snapshot["status"], **session, **conflict}
                previous = snapshot["previous_close"]
                if previous is not None and Decimal(previous) != 0:
                    delta = Decimal(snapshot["price"])-Decimal(previous)
                    values.update(ch=float(delta), chp=float(delta/Decimal(previous)*100),
                                  prev_close_price=float(previous))
                result.append({"s":"ok", "n":ticker, "v":values,
                               **{k:snapshot[k] for k in ("quote_time","fetched_at","delay_seconds","status")},
                               **session, **conflict, "read_at": read_at,
                               "time_type": "provider_quote" if stamp is not None else None})
                continue
            page = quote_page(meta)
            latest = page["bars"][-1] if page["bars"] else None
            observed_now = now_ms()
            session = session_status(meta["source"], meta["symbol"], observed_now, metadata=meta)
            conflict = _session_observation(
                meta["source"], meta["symbol"], session,
                latest.get("start") if latest else None, meta,
                event_end=latest.get("end") if latest else None,
            )
            fetch_status = page.get("fetch_status", "ok")
            read_at = page.get("read_at", page.get("as_of"))
            values = {"short_name": shown, "description": shown + " · 平台行情" + (" · " + meta["price_description"] if meta.get("price_description") else ""),
                      "exchange": meta["source"].upper(), **session, **conflict,
                      "fetched_at": page.get("as_of"), "read_at": read_at, "fetch_status": fetch_status,
                      "time_type": "source_m1" if latest else None, "resolution": "M1"}
            if latest:
                values["lp"] = float(latest["close"])
                values.update(quote_time=None, data_start=latest.get("start"), data_end=latest.get("end"))
                if meta["basis"] == "bid":
                    values["bid"] = values["lp"]
                elif meta["basis"] == "ask":
                    values["ask"] = values["lp"]
                # Missing prior-session data must not hide a valid last price.
                try:
                    previous = quote_previous_close(meta, latest)
                    if previous is not None and previous > 0:
                        delta = Decimal(latest["close"]) - previous
                        values.update(ch=float(delta), chp=float(delta / previous * 100),
                                      prev_close_price=float(previous))
                except Exception:
                    pass
            result.append({"s": "ok", "n": ticker, "v": values, **session,
                           **conflict, "fetched_at": page.get("as_of"), "read_at": read_at,
                           "fetch_status": fetch_status, "data_start": latest.get("start") if latest else None,
                           "data_end": latest.get("end") if latest else None, "time_type": "source_m1" if latest else None,
                           "resolution": "M1"})
        except Exception:
            observed_now = now_ms()
            session = session_status(meta["source"], meta["symbol"], observed_now, metadata=meta) if meta else {
                "market_session": "unknown", "session_reason": None, "calendar_verified": False, "calendar_version": None}
            result.append({"s": "error", "n": ticker,
                           "v": {"description": "平台报价暂不可用，请重试", **session,
                                 "quote_time": None, "data_start": None, "read_at": observed_now,
                                 "fetch_status": "fetch_failed",
                                 **({"short_name": meta.get("display_symbol") or display_code(meta["symbol"], meta["source"]),
                                     "exchange": meta["source"].upper()} if meta else {})}})
    with transaction() as db:
        for ident in managed:
            if len(ident) > 80:
                raise HTTPException(422, "无效品种")
            inst = db.get(Instrument, ident)
            if body.client:
                try:
                    inst = resolve(db, ident)
                except HTTPException:
                    result.append(
                        {"s": "error", "n": ident, "v": {"description": "品种暂不可用"}}
                    )
                    continue
                renew_demand(db, body.client, inst)
            bar = (
                db.scalar(
                    select(Bar)
                    .where(Bar.instrument_id == ident, Bar.timeframe == "M1")
                    .order_by(Bar.start.desc())
                    .limit(1)
                )
                if inst
                else None
            )
            dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == ident)) if inst else None
            session_meta = {"calendar_profile": inst.calendar_profile, "calendar_verified": bool(inst.calendar_profile),
                            "source_identity": dataset.identity if dataset else None} if inst else {}
            if not bar:
                if inst:
                    session = session_status(inst.source, inst.symbol, now_ms(), metadata=session_meta)
                    result.append({"s": "ok", "n": ident, "quality": "pending", **session, "v": {
                        "short_name": display_code(inst.symbol, inst.source),
                        "description": display_code(inst.symbol, inst.source) + " · 报价准备中",
                        "exchange": inst.source.upper(),
                        **session, "time_type": None, "quote_time": None, "data_start": None,
                    }})
                else:
                    result.append({"s": "error", "n": ident,
                                   "v": {"description": "未知品种"}})
                continue
            values = {
                "lp": float(bar.close),
                "short_name": display_code(inst.symbol, inst.source),
                "description": display_code(inst.symbol, inst.source) + " · " + inst.basis + " · M1",
                "exchange": inst.source.upper(),
            }
            if inst.basis == "bid":
                values["bid"] = float(bar.close)
            observed_now = now_ms()
            age = max(0, observed_now - bar.end)
            session = session_status(inst.source, inst.symbol, observed_now, metadata=session_meta)
            quality = "fresh" if age <= 180000 else "closed" if session["market_session"] == "closed" else "stale"
            conflict = _session_observation(inst.source, inst.symbol, session, bar.start, session_meta,
                                            event_end=bar.end)
            fetched_at = bar.received_at or None
            values.update(session, quote_time=None, data_start=bar.start, data_end=bar.end,
                          fetched_at=fetched_at, read_at=observed_now, time_type="source_m1", resolution="M1",
                          **conflict)
            session_start = ms(session_bounds(instant(bar.start), calendar_for(inst))[0])
            previous = db.scalar(
                select(Bar)
                .where(
                    Bar.instrument_id == ident,
                    Bar.timeframe == "D1",
                    Bar.complete.is_(True),
                    Bar.end <= session_start,
                )
                .order_by(Bar.end.desc())
                .limit(1)
            )
            # Bound calendar scanning for old caches; a missing trading minute
            # invalidates the previous-close reference, a scheduled closure does not.
            if (
                previous
                and previous.close != 0
                and session_start - previous.end <= 14 * DAY
                and not has_trading_gap(
                    instant(previous.end),
                    instant(session_start),
                    calendar_for(inst),
                    gold=is_gold(inst.id),
                    closures=closures_from(inst.calendar_profile),
                )
            ):
                delta = bar.close - previous.close
                values.update(
                    ch=float(delta),
                    chp=float(delta / previous.close * 100),
                    prev_close_price=float(previous.close),
                )
            result.append(
                {
                    "s": "ok",
                    "n": ident,
                    "v": values,
                    "as_of": bar.end,
                    "basis": inst.basis,
                    "resolution": "M1",
                    "quality": quality,
                    "age_ms": age,
                    **session,
                    **conflict,
                    "fetched_at": fetched_at,
                    "read_at": observed_now,
                    "data_start": bar.start,
                    "data_end": bar.end,
                    "time_type": "source_m1",
                }
            )
    for row in result:
        row["v"] = describe(row["v"])
    return result
