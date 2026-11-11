"""On-demand history orchestration. Datafeed requests never mean provider exhaustion."""

import time
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select

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
from .market_names import display_code
from .query_errors import QueryError
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
    """Legacy count response over the same scoped snapshot used by every refresh."""
    from .catalog_sync import refresh

    return refresh("oanda")["count"]


def resolve(db, ident):
    inst = db.get(Instrument, ident)
    entry = db.get(MarketCatalog, ident)
    if entry is None and ident.startswith("OANDA:"):
        from .history_catalog import oanda_entry

        entry = oanda_entry(db, ident[6:])
    if entry and ident.startswith("HC:"):
        raise HTTPException(422, "自建来源目录仅用于登记历史，不作为平台或实时身份")
    if entry and entry.source == "oanda":
        from .history_catalog import account_scope

        scope = (entry.metadata_json or {}).get("history_account_scope")
        if scope is not None and scope != account_scope():
            raise HTTPException(422, "此品种不属于当前账户目录，历史保留")
    if entry and entry.source == "fxcm":
        raise HTTPException(422, "FXCM仅支持平台原生或显式自建历史，不支持实时身份")
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
    snapshot_only: bool = False
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
    from .storage import CompositeRevision, HistoryVersion, MarketComposite, MarketDataset
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == inst.id))
    composite = db.scalar(select(MarketComposite).where(MarketComposite.instrument_id == inst.id))
    if composite_revision_id is not None:
        revision = db.get(CompositeRevision, composite_revision_id)
        if not composite or not revision or revision.composite_id != composite.id:
            raise ValueError("需求修订不属于所选组合行情")
    live_source = dataset and dataset.identity["source"] == "oanda"
    from .realtime_switch import enabled

    managed_id = inst.id
    if composite_revision_id is not None:
        version = db.get(HistoryVersion, revision.history_version_id)
        source_dataset = db.get(MarketDataset, version.dataset_id) if version else None
        if not source_dataset:
            raise ValueError("组合固定历史数据集不存在")
        managed_id = source_dataset.instrument_id
    elif composite:
        from .storage import CompositeRevision
        active = db.get(CompositeRevision, composite.active_revision_id)
        version = db.get(HistoryVersion, active.history_version_id) if active else None
        source_dataset = db.get(MarketDataset, version.dataset_id) if version else None
        if not source_dataset:
            return
        managed_id = source_dataset.instrument_id
    if (composite or dataset) and not enabled(db, managed_id):
        return
    if not dataset and not live_source and not composite and not inst.enabled and not (
        plan and plan.realtime_enabled
    ):
        return
    ident = demand_id(client, inst.id, composite_revision_id=composite_revision_id)
    from .history_retention import lock_reference_values
    from .source_history_store import _insert

    # Core INSERT does not run the ORM reference guard. Fence the same managed
    # dataset reference before acquiring the lease row; permanent composite
    # definitions already retain their own fixed history and mappings.
    with db.no_autoflush:
        lock_reference_values(db, inst.id)
    stamp = now_ms()
    insert = _insert(db)(MarketDemand).values(id=ident, instrument_id=inst.id,
        composite_revision_id=composite_revision_id, expires=stamp + 120000, updated_at=stamp)
    incoming = insert.excluded
    statement = insert.on_conflict_do_update(index_elements=[MarketDemand.id], set_={
        "expires": case((MarketDemand.expires < incoming.expires, incoming.expires),
                        else_=MarketDemand.expires),
        "updated_at": case((MarketDemand.updated_at < incoming.updated_at, incoming.updated_at),
                           else_=MarketDemand.updated_at),
    }, where=(MarketDemand.instrument_id == incoming.instrument_id) &
        MarketDemand.composite_revision_id.is_not_distinct_from(incoming.composite_revision_id))
    demand = db.scalars(statement.returning(MarketDemand),
        execution_options={"populate_existing": True}).one_or_none()
    if demand is None:
        raise ValueError("需求租约身份冲突，请重新打开所选行情")


def usable_cached_rows(db, inst, rows, now, *, before=None):
    """Validity shared by cache pages and sparklines; retain all cached islands."""
    cutoff = (now - 5000) // 60000 * 60000
    left = rows[0]["start"] if rows else now
    right = max(before if before is not None else now + 1, cutoff)
    coverage = stored_coverage(db, inst, left, right) if rows else []
    observed_end = db.scalar(select(func.max(Bar.end)).where(
        Bar.instrument_id == inst.id, Bar.timeframe == "M1",
        Bar.complete.is_(True), Bar.end <= cutoff)) if any(
            not row["complete"] for row in rows) else None
    usable = [row for row in rows if not row.get("pending_aggregation") and (row["complete"] or (
        observed_end is not None and row["start"] < observed_end <= cutoff < row["end"]
        and covers_interval(coverage, row["start"], observed_end)
    ))]
    return usable, coverage


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
        # A forming candle represents the latest persisted observation, not
        # a promise that the provider has delivered through this wall-clock minute.
        # Advancing time alone must not remove/reinsert its native series point.
        usable, coverage = usable_cached_rows(db, inst, rows, now, before=before)
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


class RealtimeControlQuery(BaseModel):
    instrument: str = Field(min_length=1, max_length=80)
    enabled: bool = Field(strict=True)


def router(authenticated):
    r = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @r.get("/series/search")
    def series_search(query: str = "", kind: str = "all", limit: int = 100,
                      source: str | None = None, calendar: str | None = None):
        return search_series(query, kind=kind, limit=limit, source=source or None, calendar=calendar or None)

    @r.get("/series/page")
    def series_page(query: str = "", kind: str = "history", page_size: int = 25,
                    offset: int = 0, source: str | None = None, calendar: str | None = None,
                    symbol_type: str = "", cursor: str | None = None, include_total: bool = True):
        return search_series_page(query, kind=kind, page_size=page_size, offset=offset,
                                  source=source or None, calendar=calendar or None, symbol_type=symbol_type, cursor=cursor,
                                  include_total=include_total)

    @r.post("/quotes")
    def quotes(body: QuoteQuery):
        return quote_snapshot(body)

    @r.get("/realtime")
    def realtime_status(instrument: str):
        from .realtime_switch import status
        try:
            with transaction() as db:
                return status(db, instrument, now=now_ms())
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @r.post("/realtime")
    def realtime_control(body: RealtimeControlQuery):
        from .realtime_switch import set_enabled, status
        try:
            with transaction() as db:
                set_enabled(db, body.instrument, body.enabled, now=now_ms())
                return status(db, body.instrument, now=now_ms())
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @r.get("/catalog")
    def catalog(query: str = ""):
        return instrument_catalog(query)

    @r.post("/catalog/refresh")
    def sync_catalog():
        try:
            return {"count": refresh_catalog()}
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        except Exception:
            raise HTTPException(502, "来源目录刷新失败；原目录保留，请检查连接") from None

    @r.post("/resolve")
    def symbol(body: HistoryQuery):
        if body.series_kind == "provider":
            import httpx

            from .provider_chart import metadata
            from .provider_errors import resolve_error
            from .provider_yahoo import YahooError

            try:
                return metadata(body.instrument)
            except (YahooError, TimeoutError, httpx.HTTPError) as error:
                raise resolve_error(error) from None
            except (HTTPException, QueryError) as error:
                if error.status_code == 404:
                    raise HTTPException(404, {"code": "unknown_symbol", "status": "unknown_symbol",
                                               "message": "品种不存在，请刷新品种目录",
                                               "retryable": False}) from None
                raise
        if body.series_kind in ("history", "composite"):
            from .series_access import metadata
            with transaction() as db:
                try:
                    return metadata(db, body.instrument, body.series_kind)
                except ValueError as error:
                    raise HTTPException(422, str(error)) from None
        with transaction() as db:
            inst = resolve(db, body.instrument)
            from .market_presentation import present
            dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == inst.id))
            return present({
                "id": inst.id,
                "name": inst.label,
                "series_kind": "managed",
                "symbol": inst.symbol,
                "display_symbol": display_code(inst.symbol, inst.source),
                "source": inst.source,
                "basis": inst.basis,
                "precision": inst.precision,
                "calendar": inst.calendar,
                "frames": FRAMES,
                **volume_metadata(inst.source, inst.symbol),
            }, identity=dataset.identity if dataset else {"source": inst.source})

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
        from .chart_maintenance_entry import MaintenanceUnavailable, configure

        try:
            return configure(body.instrument, body.start_date)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except MaintenanceUnavailable as error:
            raise HTTPException(503, "尚未确认最早可用历史，未建立维护任务，请稍后重试") from error

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


def search_series_page(query="", *, kind="history", page_size=25, offset=0, source=None, calendar=None,
                       symbol_type="", cursor=None, include_total=True):
    """Compatibility adapter over the canonical series-directory seam."""
    from .series_directory import page
    return page(query, kind=kind, page_size=page_size, offset=offset, source=source,
                calendar=calendar, symbol_type=symbol_type, cursor=cursor,
                include_total=include_total, provider_page=_provider_series_page)


def _all_series_page(query, *, page_size, source, calendar, symbol_type, cursor):
    """Legacy private seam retained for integrations; delegates to the core."""
    from .series_directory import page
    return page(query, kind="all", page_size=page_size, source=source, calendar=calendar,
                symbol_type=symbol_type, cursor=cursor, provider_page=_provider_series_page)


def _provider_series_page(query, *, source=None, symbol_type="", offset=0, page_size=25, include_total=True):
    from .chart_series import encode
    from .instrument_directory import search
    from .platform_catalog import _entry
    from .search_types import symbol_type as search_type

    asset = {"stock": "equity", "fund": "etf", "futures": "future", "commodity": "metal"}.get(symbol_type, symbol_type) or None
    with transaction() as db:
        page = search(db, query=query, source=source, asset=asset, offset=offset, limit=page_size,
                      include_total=include_total)
    items = []
    for row in page["items"]:
        item = _entry(row)
        item.update({"series_kind": "provider", "ticker": encode(item["id"], "provider"),
            "supported": bool(item["capabilities"]["native_periods"]),
            "type": search_type(item["asset_class"]),
            "description": " · ".join((item["series_kind_display"], item["source_display"], item["price_basis_display"], "原生周期"))})
        items.append(item)
    has_more = offset + len(items) < page["total"] if include_total else page["has_more"]
    return {"items": items, **({"total": page["total"]} if include_total else {}), "offset": offset, "page_size": page_size,
        "has_more": has_more, "next_offset": offset + len(items) if has_more else None}


def search_series(query="", *, kind="all", limit=100, source=None, calendar=None):
    """Compatibility list response over the canonical series-directory seam."""
    from .series_directory import search
    return search(query, kind=kind, limit=limit, source=source, calendar=calendar,
                  provider_page=_provider_series_page)


def instrument_catalog(query: str = "", *, limit=250, source=None, managed_status=True):
    from .instrument_directory import search
    from .platform_catalog import _entry
    from .storage import ChartPublication

    with transaction() as db:
        page = search(db, query=query, source=source, limit=limit or 1_000_000)
        plans = {p.instrument_id: p for p in db.scalars(select(ChartHistoryPlan))} if managed_status else {}
        published = {p.instrument_id for p in db.scalars(select(ChartPublication).where(
            ChartPublication.complete_count > 0))} if managed_status else set()
        failures = set(db.scalars(select(ImportJob.instrument_id).where(
            ImportJob.chart_plan.is_(True), ImportJob.status == 'failed'))) if managed_status else set()
    result = []
    for row in page["items"]:
        entry, info = _entry(row), row["metadata_json"]
        if not entry["available"]:
            continue
        entry.update({"supported": bool(entry["capabilities"]["native_periods"]),
            "series_kinds": ["provider"] if entry["source"] in ("yahoo", "akshare", "dukascopy", "fxcm") else ["provider", "managed"],
            "english_name": info.get("english_name", row["supplier_name"]),
            "chinese_name": row["name_zh"], "exchange": info.get("exchange"),
            "currency": info.get("currency"), "search_status": "local"})
        plan = plans.get(entry["id"])
        entry["managed_status"] = ('未维护' if plan is None else
            '失败，已发布历史保留' if entry['id'] in failures else
            '部分已发布，范围见历史任务' if entry['id'] in published else '处理中')
        result.append(entry)
    return result


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


def quote_snapshot(body: QuoteQuery, *, previous_close=None, provider_page=None):
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
                    values = {"short_name": shown, "description": meta.get("presentation_description", meta["name"] + (" · 自建" if kind == "history" else " · 组合")), "exchange": meta["source"].upper()}
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
                                previous = facts.get("previous_close")
                                if previous is not None and previous != 0:
                                    delta = Decimal(str(facts["price"])) - Decimal(str(previous))
                                    previous = Decimal(str(previous))
                                    values.update(
                                        ch=float(delta),
                                        chp=float(delta / previous * 100),
                                        prev_close_price=float(previous),
                                    )
                            price_type = facts["price_type"]
                            precise = price_type == "sampled_bid"
                            candle_sample = price_type == "sampled_candle_close"
                            provenance = facts.get("provenance") or {}
                            candle = provenance.get("candle") or {}
                            # A candle close is observed at response receive
                            # time, while its price belongs to the source
                            # interval.  Preserve both clocks and the
                            # acquisition contract; do not present it as a
                            # precise Bid quote or as an old confirmed bar.
                            sample_start = candle.get("start") if candle_sample else provenance.get("start")
                            sample_end = candle.get("end") if candle_sample else provenance.get("end")
                            values.update(quote_time=facts["observed_at"] if precise else None,
                                observed_at=facts["observed_at"] if candle_sample else None,
                                data_start=None if precise else sample_start,
                                data_end=None if precise else sample_end,
                                time_type="composite_snapshot",
                                realtime_enabled=facts["realtime_enabled"],
                                observation_type=("provider_quote" if precise else
                                                  "candle_close_sample" if candle_sample else "source_m1"),
                                observation_mode=("stream_quote" if precise else
                                                  "candle_close_sample" if candle_sample else "stored_confirmed_m1"),
                                price_type=price_type, quote_ready=facts["quote_ready"],
                                confirmed_tail_ready=facts["confirmed_tail_ready"], quality=facts["quality"],
                                **{key: facts.get(key) for key in ("market_session", "session_reason", "calendar_verified",
                                    "calendar_version", "read_at", "revision_id", "input_revision", "source_identity",
                                    "session_conflict", "session_conflict_reason", "fetch_status", "confirmation_error", "confirmation_status", "error_evidence")})
                            values["description"] += " · " + (
                                "抽样Bid" if precise else
                                "当前未闭合M1收盘采样" if candle_sample else
                                "保存的确认M1收盘" if facts["price"] is not None else "等待报价")
                            if not facts["realtime_enabled"]:
                                values["description"] += " · 实时流已关闭"

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
            meta = (metadata(ident, cached_only=True) if body.snapshot_only else
                    metadata(ident, deadline=deadline) if ident.startswith("YAHOO:") else metadata(ident))
            shown = (meta.get("display_symbol") or display_code(meta["symbol"], meta["source"], meta.get("asset_type")))
            if body.snapshot_only:
                from .provider_quote_reads import snapshot as local_snapshot
                row = local_snapshot(meta)
                values = row['v']
                values.update(short_name=shown, exchange=meta.get('exchange', meta['source'].upper()),
                    description=meta.get('presentation_description', meta['name'] + ' · 平台'),
                    **session_status(meta['source'], meta['symbol'], now_ms(), metadata=meta))
                values.pop('description_base', None)
                result.append({**row, 'n':ticker})
                continue
            if meta["source"] == "yahoo":
                from .provider_service import yahoo_quote
                snapshot = yahoo_quote(meta, deadline=deadline)
                stamp = snapshot["quote_time"]
                delay = snapshot["delay_seconds"]
                read_at = now_ms()
                session = session_status(meta["source"], meta["symbol"], now_ms(), metadata=meta)
                description = meta.get("presentation_description", meta["name"] + " · Yahoo 市场报价")

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
            page = (provider_page or quote_page)(meta)
            latest = page["bars"][-1] if page["bars"] else None
            observed_now = now_ms()
            session = session_status(meta["source"], meta["symbol"], observed_now, metadata=meta)
            conflict = _session_observation(
                meta["source"], meta["symbol"], session,
                latest.get("start") if latest else None, meta,
                event_end=latest.get("end") if latest else None,
            )
            quote_frame = "D1" if meta["source"] == "akshare" else "M1"
            quote_time_type = "source_d1" if quote_frame == "D1" else "source_m1"
            fetch_status = page.get("fetch_status", "ok")
            read_at = page.get("read_at", page.get("as_of"))
            values = {"short_name": shown, "description": meta.get("presentation_description", shown + " · 平台" + (" · " + meta["price_description"] if meta.get("price_description") else "")),
                      "exchange": meta["source"].upper(), **session, **conflict,
                      "fetched_at": page.get("as_of"), "read_at": read_at, "fetch_status": fetch_status,
                      **{key:page[key] for key in ("wait_reason", "last_success_at", "cache_age_ms") if key in page},
                      **({'error_evidence': page['error_evidence']} if page.get('error_evidence') else {}),
                      "time_type": quote_time_type if latest else None, "resolution": quote_frame}
            if latest:
                values["lp"] = float(latest["close"])
                values.update(quote_time=None, data_start=latest.get("start"), data_end=latest.get("end"))
                if meta["basis"] == "bid":
                    values["bid"] = values["lp"]
                elif meta["basis"] == "ask":
                    values["ask"] = values["lp"]
                # Waiting reads are cache-only, including derived fields: a
                # cold previous-close lookup can otherwise open supplier HTTP.
                # Waiting reads may enrich from completed local D1 data, but
                # must not open supplier IO. Never pair a newer lp with old ch.
                try:
                    if fetch_status in ("pending", "stale"):
                        from .provider_quote_reads import local_previous_close
                        previous = local_previous_close(meta, latest)
                    else:
                        previous = (previous_close or quote_previous_close)(meta, latest)
                    if previous is not None and previous > 0:
                        delta = Decimal(latest["close"]) - previous
                        values.update(ch=float(delta), chp=float(delta / previous * 100),
                                      prev_close_price=float(previous))
                except Exception:
                    pass
            result.append({"s": "ok", "n": ticker, "v": values, **session,
                           **conflict, "fetched_at": page.get("as_of"), "read_at": read_at,
                           "fetch_status": fetch_status, "data_start": latest.get("start") if latest else None,
                           "data_end": latest.get("end") if latest else None, "time_type": quote_time_type if latest else None,
                           "resolution": quote_frame})
        except Exception as error:
            from .market_notices import error_evidence
            observed_now = now_ms()
            session = session_status(meta["source"], meta["symbol"], observed_now, metadata=meta) if meta else {
                "market_session": "unknown", "session_reason": None, "calendar_verified": False, "calendar_version": None}
            result.append({"s": "error", "n": ticker,
                           "v": {"description": "平台报价暂不可用，请重试", **session,
                                 "quote_time": None, "data_start": None, "read_at": observed_now,
                                 "fetch_status": "fetch_failed",
                                 "error_evidence": error_evidence(
                                     error, provider=meta.get('source', '') if meta else '', operation='quote_snapshot'),
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
                except (HTTPException, QueryError):
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
            from .market_presentation import present
            presentation = present({"symbol": inst.symbol, "name": inst.label, "source": inst.source,
                                    "basis": inst.basis, "series_kind": "managed"},
                                   identity=dataset.identity if dataset else None) if inst else None
            if not bar:
                if inst:
                    session = session_status(inst.source, inst.symbol, now_ms(), metadata=session_meta)
                    result.append({"s": "ok", "n": ident, "quality": "pending", **session, "v": {
                        "short_name": presentation["display_symbol"],
                        "description": presentation["presentation_description"] + " · 报价准备中",
                        "exchange": inst.source.upper(),
                        **session, "time_type": None, "quote_time": None, "data_start": None,
                    }})
                else:
                    result.append({"s": "error", "n": ident,
                                   "v": {"description": "未知品种"}})
                continue
            values = {
                "lp": float(bar.close),
                "short_name": presentation["display_symbol"],
                "description": presentation["presentation_description"],
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
