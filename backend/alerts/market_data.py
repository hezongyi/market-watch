"""On-demand history orchestration. Datafeed requests never mean provider exhaustion."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_data import FRAMES, bounds, chart_rows
from .coverage import covers_interval
from .domain import Calendar, bucket_bounds, has_trading_gap, scheduled_open, session_bounds
from .market import stored_coverage
from .providers import fetch_oanda_catalog
from .storage import (
    Bar,
    ImportJob,
    Instrument,
    MarketCatalog,
    MarketDemand,
    WeeklyHistoryRequest,
    instant,
    ms,
    now_ms,
    transaction,
)

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
        for old in db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda")):
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
    timeframe: str
    before: int | None = Field(default=None, gt=0)
    limit: int = Field(default=300, ge=1, le=2000)


class Activity(BaseModel):
    client: str = Field(min_length=1, max_length=40)
    instrument: str = Field(max_length=80)


class QuoteQuery(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=100)
    client: str | None = Field(default=None, min_length=1, max_length=40)


def renew_demand(db, client, inst):
    import hashlib

    ident = hashlib.sha256((client + "|" + inst.id).encode()).hexdigest()[:40]
    demand = db.get(MarketDemand, ident)
    if not demand:
        demand = MarketDemand(id=ident, instrument_id=inst.id)
        db.add(demand)
    demand.expires = now_ms() + 120000
    demand.updated_at = now_ms()


def plan_history(body: HistoryQuery):
    if body.timeframe not in FRAMES:
        raise HTTPException(422, "不支持的周期")
    right = min(body.before or now_ms(), (now_ms() - 5000) // 60000 * 60000)
    # Count is a preference, not a reason to eagerly download decades of M1.
    span = min(31 * DAY, max(2 * DAY, int(FRAME_MS[body.timeframe] * body.limit * 1.5)))
    left = max(0, right - span)
    with transaction() as db:
        inst = resolve(db, body.instrument)
        calendar = Calendar(inst.calendar)
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
        errors = [j.error for j in jobs if j.status == "failed"]
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
        row = db.get(WeeklyHistoryRequest, ident)
        if row.cursor != cursor or row.remaining != remaining:
            return True
        if result["status"] in ("ready", "empty_interval"):
            bars = [bar for bar in result["bars"]
                    if result["requested_start"] <= bar["start"] < cursor]
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


def router(authenticated):
    r = APIRouter(prefix="/api/market-data", dependencies=[Depends(authenticated)])

    @r.post("/quotes")
    def quotes(body: QuoteQuery):
        result = []
        with transaction() as db:
            for ident in dict.fromkeys(body.symbols):
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
                if not bar:
                    result.append({"s": "error", "n": ident, "v": {"description": "暂无本地报价"}})
                    continue
                values = {
                    "lp": float(bar.close),
                    "short_name": inst.symbol,
                    "description": inst.label + " · " + inst.basis + " · M1",
                    "exchange": inst.source.upper(),
                }
                if inst.basis == "bid":
                    values["bid"] = float(bar.close)
                observed_now = now_ms()
                age = max(0, observed_now - bar.end)
                is_open = scheduled_open(
                    instant(observed_now),
                    Calendar(inst.calendar),
                    gold=inst.id == "XAUUSD",
                    closures=closures_from(inst.calendar_profile),
                )
                quality = "fresh" if age <= 180000 else "stale" if is_open else "closed"
                label = {
                    "fresh": "最近更新",
                    "stale": "报价待更新",
                    "closed": "按日历休市，最后报价",
                }[quality]
                values["description"] += (
                    " · " + label + " · " + instant(bar.end).strftime("%Y-%m-%d %H:%M UTC")
                )
                session_start = ms(session_bounds(instant(bar.start), Calendar(inst.calendar))[0])
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
                        Calendar(inst.calendar),
                        gold=inst.id == "XAUUSD",
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
                    }
                )
        return result

    @r.get("/catalog")
    def catalog(query: str = ""):
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
                    "available": x.available,
                }
                for x in db.scalars(select(MarketCatalog))
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
                        "precision": inst.precision,
                        "supported": True,
                        "available": True,
                    },
                )
            return [
                x
                for x in entries.values()
                if query.upper() in (x["id"] + x["label"] + x["symbol"]).upper()
            ][:250]

    @r.post("/catalog/refresh")
    def sync_catalog():
        return {"count": refresh_catalog()}

    @r.post("/resolve")
    def symbol(body: HistoryQuery):
        with transaction() as db:
            inst = resolve(db, body.instrument)
            return {
                "id": inst.id,
                "name": inst.label,
                "source": inst.source,
                "basis": inst.basis,
                "precision": inst.precision,
                "calendar": inst.calendar,
                "frames": FRAMES,
            }

    @r.post("/activity")
    def activity(body: Activity):
        with transaction() as db:
            inst = resolve(db, body.instrument)
            renew_demand(db, body.client, inst)
        return {"ok": True}

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
