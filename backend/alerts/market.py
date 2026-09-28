"""Bounded provider I/O and conservative closed-bar ingestion."""

import argparse
import json
import os
import subprocess
import time
from datetime import timedelta
from decimal import Decimal

import httpx
from sqlalchemy import BigInteger, or_, select

from .calendar_profile import closures_from
from .config import settings
from .coverage import covers_interval
from .domain import Calendar, Candle, aggregate, bucket_bounds, scheduled_open
from .providers import fetch_binance, fetch_oanda
from .service import evaluate_quote, evaluate_watch
from .storage import (
    Audit,
    Bar,
    ImportJob,
    Instrument,
    Preference,
    Watch,
    bootstrap,
    candle_dict,
    instant,
    ms,
    now_ms,
    transaction,
)


def fetch(symbol, start=None, end=None, mode="live"):
    args = ["node", settings.adapter_path, symbol, "history" if start else mode]
    if start:
        args += [start, end]
    env = dict(os.environ)
    if settings.market_proxy:
        env.update(HTTPS_PROXY=settings.market_proxy, HTTP_PROXY=settings.market_proxy)
    result = subprocess.run(args, capture_output=True, text=True, timeout=55, env=env, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr[-600:])
    return json.loads(result.stdout)


def fetch_source(source, symbol, start=None, end=None, mode="live"):
    if source == "oanda":
        return fetch_oanda(symbol, start, end, mode)
    if source == "binance":
        return fetch_binance(symbol, start, end, mode)
    if source == "dukascopy":
        return fetch(symbol, start, end, mode)
    raise ValueError(f"Unknown source: {source}")


def upsert(db, instrument_id, timeframe, c):
    row = db.scalar(
        select(Bar).where(
            Bar.instrument_id == instrument_id, Bar.timeframe == timeframe, Bar.start == ms(c.start)
        )
    )
    values = {k: getattr(c, k) for k in ["open", "high", "low", "close", "complete"]}
    if row:
        if any(getattr(row, k) != v for k, v in values.items()):
            db.add(
                Audit(
                    kind="candle_revision",
                    details={
                        "instrument": instrument_id,
                        "timeframe": timeframe,
                        "previous": candle_dict(row.candle()),
                    },
                )
            )
            for k, v in values.items():
                setattr(row, k, v)
            row.revision += 1
            row.received_at = now_ms()
    else:
        row = Bar(
            instrument_id=instrument_id,
            timeframe=timeframe,
            start=ms(c.start),
            end=ms(c.end),
            **values,
        )
        db.add(row)
    db.flush()
    return row


def stored_coverage(db, instrument, left, right):
    coverage = []
    if instrument.source == "oanda":
        db.flush()
        for audit in db.scalars(
            select(Audit).where(
                Audit.kind == "provider_query_coverage",
                Audit.details["instrument"].as_string() == instrument.id,
                or_(
                    Audit.details["range_start"].as_string().cast(BigInteger).is_(None),
                    (Audit.details["range_start"].as_string().cast(BigInteger) < right)
                    & (Audit.details["range_end"].as_string().cast(BigInteger) > left),
                ),
            )
        ):
            details = audit.details
            if (
                details.get("instrument") != instrument.id
                or details.get("basis") != instrument.basis
            ):
                continue
            final_cutoff = ((details["received_at"] - 5000) // 60000) * 60000
            for span in details["ranges"]:
                coverage.append({"start": span["start"], "end": min(span["end"], final_cutoff)})
    return coverage


def ingest(db, instrument, payload, received_at=None):
    if payload.get("source") and payload["source"] != instrument.source:
        raise ValueError("行情来源不匹配，拒绝混合数据")
    if payload.get("basis") and payload["basis"] != instrument.basis:
        raise ValueError("报价口径不匹配，拒绝混合数据")
    received_at = received_at or now_ms()
    closures = closures_from(instrument.calendar_profile)
    if any(
        c.start <= instant(int(r["timestamp"])) < c.end for r in payload["rows"] for c in closures
    ):
        raise ValueError("行情观测与已配置休市区间冲突，请核对交易日历")
    if instrument.source == "oanda" and payload.get("coverage"):
        db.add(
            Audit(
                kind="provider_query_coverage",
                details={
                    "instrument": instrument.id,
                    "source": instrument.source,
                    "basis": instrument.basis,
                    "received_at": received_at,
                    "ranges": payload["coverage"],
                    "range_start": min(r["start"] for r in payload["coverage"]),
                    "range_end": max(r["end"] for r in payload["coverage"]),
                    "meaning": "successful_query_not_proof_of_every_market_observation",
                },
            )
        )
    changed = []
    for raw in payload["rows"]:
        start = instant(int(raw["timestamp"]))
        if start.second or start.microsecond:
            raise ValueError("Provider M1 boundary is not a whole minute")
        end = start + timedelta(minutes=1)
        # Exclude forming minute; conservative 5s margin. Provider finality remains a source gate.
        if ms(end) > received_at - 5000:
            continue
        c = Candle(start, end, *(Decimal(str(raw[k])) for k in ["open", "high", "low", "close"]))
        upsert(db, instrument.id, "M1", c)
        changed.append(start)
    touched = set(changed)
    if instrument.source == "oanda":
        for span in payload.get("coverage", []):
            cursor = ((span["start"] + 59999) // 60000) * 60000
            cutoff = min(span["end"], received_at - 5000)
            while cursor + 60000 <= cutoff:
                touched.add(instant(cursor))
                cursor += 60000
    if not touched:
        return 0
    calendar = Calendar(instrument.calendar)
    earliest = ms(bucket_bounds(min(touched), "D1", calendar)[0])
    latest_boundary = ms(bucket_bounds(max(touched), "D1", calendar)[1])
    coverage = stored_coverage(db, instrument, earliest, latest_boundary)
    # Include all minute rows in touched buckets, including older bars already stored.
    calendar = Calendar(instrument.calendar)
    for timeframe in ["M5", "M15", "H1", "H4", "D1"]:
        bounds = {bucket_bounds(t, timeframe, calendar) for t in touched}
        for left, right in sorted(bounds):
            rows = db.scalars(
                select(Bar)
                .where(
                    Bar.instrument_id == instrument.id,
                    Bar.timeframe == "M1",
                    Bar.start >= ms(left),
                    Bar.start < ms(right),
                )
                .order_by(Bar.start)
            ).all()
            expected = set()
            t = left
            while t < right:
                if scheduled_open(
                    t,
                    calendar,
                    gold=instrument.id == "XAUUSD",
                    closures=closures,
                ):
                    expected.add(t)
                t += timedelta(minutes=1)
            if coverage and covers_interval(coverage, ms(left), ms(right)):
                # Sparse upstream observations are valid only within a fully queried interval.
                # No synthetic flat candles or prices are inserted.
                expected = {r.candle().start for r in rows}
            c = aggregate([r.candle() for r in rows], left, right, expected_starts=expected)
            if c:
                complete = c.complete and bool(expected) and ms(right) <= received_at - 5000
                c = Candle(c.start, c.end, c.open, c.high, c.low, c.close, complete)
                upsert(db, instrument.id, timeframe, c)
    return len(changed)


def enqueue_repair(db, instrument, left, right):
    if left >= right:
        return
    t = instant(left)
    while ms(t) < right:
        if scheduled_open(
            t,
            Calendar(instrument.calendar),
            gold=instrument.id == "XAUUSD",
            closures=closures_from(instrument.calendar_profile),
        ):
            break
        t += timedelta(minutes=1)
    else:
        return
    existing = db.scalar(
        select(ImportJob)
        .where(
            ImportJob.instrument_id == instrument.id,
            ImportJob.start <= left,
            ImportJob.end >= right,
            ImportJob.cursor <= left,
            ImportJob.status.in_(["pending", "running", "failed"]),
        )
        .limit(1)
    )
    if existing:
        existing.priority = 0
        return
    db.add(ImportJob(instrument_id=instrument.id, start=left, end=right, cursor=left, priority=0))
    db.add(
        Audit(
            kind="market_recovery_queued",
            details={"instrument": instrument.id, "start": left, "end": right},
        )
    )
    db.flush()


def queue_recovery(db, instrument, payload, received_at=None):
    """Repair inter-window and internal gaps, excluding certified sparse OANDA spans."""
    cutoff = ((received_at if received_at is not None else now_ms()) - 5000) // 60000 * 60000
    incoming = sorted(
        {int(r["timestamp"]) for r in payload["rows"] if int(r["timestamp"]) + 60000 <= cutoff}
    )
    left = payload.get("window_start", incoming[0] if incoming else None)
    right = payload.get("window_end", incoming[-1] + 60000 if incoming else None)
    if left is None or right is None:
        return
    left = (left + 59999) // 60000 * 60000
    right = min(right // 60000 * 60000, cutoff)
    if right <= left:
        return
    previous_end = db.scalar(
        select(Bar.end)
        .where(Bar.instrument_id == instrument.id, Bar.timeframe == "M1", Bar.end <= left)
        .order_by(Bar.end.desc())
        .limit(1)
    )
    coverage = (
        [{"start": r["start"], "end": min(r["end"], cutoff)} for r in payload.get("coverage", [])]
        if instrument.source == "oanda"
        else []
    )
    coverage += stored_coverage(
        db, instrument, previous_end if previous_end is not None else left, right
    )
    if (
        previous_end is not None
        and previous_end < left
        and not covers_interval(coverage, previous_end, left)
    ):
        enqueue_repair(db, instrument, previous_end, left)
    stored = db.scalars(
        select(Bar.start).where(
            Bar.instrument_id == instrument.id,
            Bar.timeframe == "M1",
            Bar.start >= left,
            Bar.end <= right,
            Bar.complete.is_(True),
        )
    ).all()
    cursor = left
    for at in sorted(set(stored) | {t for t in incoming if left <= t < right}) + [right]:
        if cursor < at and not covers_interval(coverage, cursor, at):
            enqueue_repair(db, instrument, cursor, at)
        cursor = at + 60000


def queue_initial_history(db, *, end=None):
    """One durable bootstrap per source/instrument, split into newest-first daily jobs."""
    days = settings.initial_history_days
    if not days:
        return 0
    right = ((end if end is not None else now_ms()) - 5000) // 60000 * 60000
    left = max(0, right - days * 86400_000)
    count = 0
    for instrument in db.scalars(
        select(Instrument).where(Instrument.enabled.is_(True)).with_for_update()
    ):
        key = f"initial_history:{instrument.id}:{instrument.source}:{instrument.basis}"
        if db.get(Preference, key):
            continue
        cursor = right
        while cursor > left:
            start = max(left, ((cursor - 1) // 86400_000) * 86400_000)
            # Completed slices count only when a job's cursor actually reached its end.
            existing = db.scalar(
                select(ImportJob)
                .where(
                    ImportJob.instrument_id == instrument.id,
                    ImportJob.start <= start,
                    ImportJob.end >= cursor,
                    or_(
                        ImportJob.status.in_(["pending", "running", "failed"]),
                        (ImportJob.status == "complete") & (ImportJob.cursor >= cursor),
                    ),
                )
                .limit(1)
            )
            if not existing:
                db.add(
                    ImportJob(
                        instrument_id=instrument.id,
                        start=start,
                        end=cursor,
                        cursor=start,
                        priority=50,
                    )
                )
                count += 1
            cursor = start
        db.add(Preference(key=key, value={"start": left, "end": right, "days": days}))
        db.add(
            Audit(
                kind="initial_history_queued",
                details={
                    "instrument": instrument.id,
                    "source": instrument.source,
                    "start": left,
                    "end": right,
                },
            )
        )
        db.flush()
    return count


def once(symbol=None, start=None, end=None):
    with transaction() as db:
        instruments = [
            (i.id, i.symbol, i.source)
            for i in db.scalars(select(Instrument))
            if (i.id == symbol if symbol else i.enabled)
        ]
    for instrument_id, provider_symbol, source in instruments:
        with transaction() as db:
            backoff = db.get(Preference, f"market_backoff:{source}")
            if backoff and backoff.value.get("until", 0) > now_ms():
                continue
        try:
            payload = fetch_source(source, provider_symbol, start, end)
            with transaction() as db:
                inst = db.get(Instrument, instrument_id)
                if not start:
                    queue_recovery(db, inst, payload)
                count = ingest(db, inst, payload)
                db.add(
                    Audit(
                        kind="market_ingested",
                        details={"instrument": instrument_id, "minutes": count},
                    )
                )
            with transaction() as db:
                for watch_id in db.scalars(
                    select(Watch.id).where(
                        Watch.status == "active", Watch.instrument_id == instrument_id
                    )
                ).all():
                    evaluate_watch(db, watch_id)
            if not start:
                with transaction() as db:
                    needs_quotes = any(
                        w.rule.get("timeframe") == "tick"
                        for w in db.scalars(
                            select(Watch).where(
                                Watch.status == "active", Watch.instrument_id == instrument_id
                            )
                        )
                    )
                if needs_quotes:
                    quotes = fetch_source(source, provider_symbol, mode="quote")
                    with transaction() as db:
                        inst = db.get(Instrument, instrument_id)
                        for raw in quotes["rows"]:
                            evaluate_quote(
                                db,
                                inst,
                                int(raw["timestamp"]),
                                Decimal(str(raw["bidPrice"])),
                                Decimal(str(raw["askPrice"])),
                            )
            if not start:
                with transaction() as db:
                    inst = db.get(Instrument, instrument_id)
                    if inst.error:
                        db.add(
                            Audit(
                                kind="market_recovered",
                                details={"instrument": instrument_id, "source": source},
                            )
                        )
                    latest = db.scalar(
                        select(Bar.end)
                        .where(Bar.instrument_id == instrument_id, Bar.timeframe == "M1")
                        .order_by(Bar.end.desc())
                        .limit(1)
                    )
                    inst.last_received = now_ms()
                    inst.quality = "receiving" if latest and now_ms() - latest < 180000 else "stale"
                    inst.error = None
        except (RuntimeError, ValueError, subprocess.TimeoutExpired, OSError, httpx.HTTPError) as e:
            with transaction() as db:
                inst = db.get(Instrument, instrument_id)
                inst.quality = "error"
                inst.error = str(e)[:600]
                if "429" in str(e):
                    delay = db.get(Preference, f"market_backoff:{source}")
                    if delay:
                        delay.value = {"until": now_ms() + 300_000}
                    else:
                        db.add(
                            Preference(
                                key=f"market_backoff:{source}", value={"until": now_ms() + 300_000}
                            )
                        )
                db.add(
                    Audit(
                        kind="market_error",
                        details={"instrument": instrument_id, "error": str(e)[:600]},
                    )
                )
    with transaction() as db:
        db.add(Audit(kind="market_heartbeat", details={}))


def import_once():
    """One daily slice per iteration. Durable cursor and lease permit safe restart."""
    with transaction() as db:
        job = db.scalar(
            select(ImportJob)
            .where(
                ImportJob.next_at <= now_ms(),
                or_(
                    ImportJob.status == "pending",
                    (ImportJob.status == "running") & (ImportJob.lease_until < now_ms()),
                ),
            )
            .order_by(ImportJob.priority, ImportJob.start.desc(), ImportJob.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if not job:
            return False
        inst = db.get(Instrument, job.instrument_id)
        source = inst.source
        backoff = db.get(Preference, f"market_backoff:{source}")
        if backoff and backoff.value.get("until", 0) > now_ms():
            job.next_at = backoff.value["until"]
            return False
        job.status = "running"
        job.lease_until = now_ms() + 120_000
        lease = job.lease_until
        ident, symbol, left, right = (
            job.id,
            db.get(Instrument, job.instrument_id).symbol,
            job.cursor,
            min(job.end, ((job.cursor // 86400_000) + 1) * 86400_000),
        )
    try:
        payload = fetch_source(
            source, symbol, instant(left).isoformat(), instant(right).isoformat()
        )
        with transaction() as db:
            job = db.scalar(select(ImportJob).where(ImportJob.id == ident).with_for_update())
            if job.status != "running" or job.lease_until != lease or job.cursor != left:
                return True
            closed_cutoff = (now_ms() - 5000) // 60000 * 60000
            fully_queried_oanda = source == "oanda" and covers_interval(
                [
                    {"start": r["start"], "end": min(r["end"], closed_cutoff)}
                    for r in payload.get("coverage", [])
                ],
                left,
                right,
            )
            if not payload["rows"] and not fully_queried_oanda:
                t = instant(left)
                inst = db.get(Instrument, job.instrument_id)
                while ms(t) < right:
                    if scheduled_open(
                        t,
                        Calendar(inst.calendar),
                        gold=inst.id == "XAUUSD",
                        closures=closures_from(inst.calendar_profile),
                    ):
                        raise ValueError("交易时段返回空数据，保留补数游标等待重试")
                    t += timedelta(minutes=1)
            inst = db.get(Instrument, job.instrument_id)
            ingest(db, inst, payload)
            if not fully_queried_oanda:
                # A nonempty response is not proof that the requested slice is complete.
                present = set(
                    db.scalars(
                        select(Bar.start).where(
                            Bar.instrument_id == inst.id,
                            Bar.timeframe == "M1",
                            Bar.start >= left,
                            Bar.end <= right,
                            Bar.complete.is_(True),
                        )
                    ).all()
                )
                cursor = (left + 59999) // 60000 * 60000
                while cursor + 60000 <= right:
                    if cursor not in present and scheduled_open(
                        instant(cursor),
                        Calendar(inst.calendar),
                        gold=inst.id == "XAUUSD",
                        closures=closures_from(inst.calendar_profile),
                    ):
                        raise ValueError("历史区间仍缺少完整 M1，保留补数游标等待重试")
                    cursor += 60000
            job.cursor = right
            job.lease_until = None
            job.error = None
            job.attempts = 0
            job.status = "complete" if right >= job.end else "pending"
            job.next_at = now_ms() + 1000
            if fully_queried_oanda and not payload["rows"]:
                db.add(
                    Audit(
                        kind="provider_empty_interval",
                        details={
                            "instrument": job.instrument_id,
                            "source": source,
                            "start": left,
                            "end": right,
                            "meaning": "queried_no_observations_not_confirmed_holiday",
                        },
                    )
                )
            for watch_id in db.scalars(
                select(Watch.id).where(
                    Watch.instrument_id == job.instrument_id, Watch.status == "active"
                )
            ).all():
                evaluate_watch(db, watch_id)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired, OSError, httpx.HTTPError) as e:
        with transaction() as db:
            job = db.scalar(select(ImportJob).where(ImportJob.id == ident).with_for_update())
            if job.status != "running" or job.lease_until != lease or job.cursor != left:
                return True
            job.error = str(e)[-600:]
            job.attempts += 1
            job.status = "failed" if job.attempts >= 5 else "pending"
            job.lease_until = None
            job.next_at = now_ms() + min(600, 30 * 2**job.attempts) * 1000
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--imports-only", action="store_true")
    parser.add_argument("--instrument", choices=["EURUSD", "XAUUSD", "BTCUSD", "BTCUSDT"])
    parser.add_argument("--start")
    parser.add_argument("--end")
    args = parser.parse_args()
    if bool(args.start) != bool(args.end):
        parser.error("--start and --end must be used together")
    if args.imports_only and (args.start or args.instrument):
        parser.error("--imports-only cannot be combined with instrument or date arguments")
    bootstrap()
    if args.imports_only:
        with transaction() as db:
            queue_initial_history(db)
        while True:
            import_once()
            with transaction() as db:
                db.add(Audit(kind="import_heartbeat", details={}))
            if args.once:
                return
            time.sleep(max(2, settings.import_poll_seconds))
    while True:
        once(args.instrument, args.start, args.end)
        if args.once or args.start:
            return
        time.sleep(max(2, settings.market_poll_seconds))


if __name__ == "__main__":
    main()
