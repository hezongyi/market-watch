"""Bounded provider I/O and conservative closed-bar ingestion."""

import argparse
import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

import httpx
from sqlalchemy import func, or_, select, update

from .bar_batch import write_bars
from .calendar_profile import closures_from
from .chart_series import is_gold
from .config import settings
from .coverage import covers_interval
from .domain import Candle, aggregate, bucket_bounds, calendar_for, scheduled_open
from .market_datasets import validate_ingestion
from .providers import fetch_binance, fetch_oanda
from .storage import (
    Audit,
    Bar,
    ChartHistoryPlan,
    ImportJob,
    Instrument,
    MarketCoverage,
    Preference,
    bootstrap,
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


def ordinary_instruments():
    """Legacy collection owns neither registered datasets nor derived composites."""
    from .storage import MarketComposite, MarketDataset

    return select(Instrument).where(
        Instrument.source.in_(("dukascopy", "oanda", "binance")),
        Instrument.id.not_in(select(MarketDataset.instrument_id)),
        Instrument.id.not_in(select(MarketComposite.instrument_id)),
    )


def realtime_instruments():
    return select(Instrument.id).outerjoin(
        ChartHistoryPlan, ChartHistoryPlan.instrument_id == Instrument.id).where(
            or_(ChartHistoryPlan.realtime_enabled.is_(True),
                ChartHistoryPlan.instrument_id.is_(None) & Instrument.enabled.is_(True)))


def realtime_error(source_filter=None):
    """Report unresolved legacy live work, including work still in backoff.

    Stored provider messages can contain credentials; health uses fixed codes.
    Registered datasets, composites and historical imports have other owners.
    """
    scope = ordinary_instruments().where(
        Instrument.source.in_(source_filter) if source_filter is not None else True)
    with transaction() as db:
        if db.scalar(scope.with_only_columns(Instrument.id).where(
                Instrument.enabled.is_(True), Instrument.error.is_not(None)).limit(1)):
            return "collection_failed"
        if db.scalar(select(ImportJob.id).where(
                ImportJob.instrument_id.in_(scope.with_only_columns(Instrument.id)),
                ImportJob.instrument_id.in_(realtime_instruments()),
                ImportJob.priority == 0, ImportJob.status.in_(("pending", "running", "failed")),
                ImportJob.error.is_not(None)).limit(1)):
            return "import_failed"
    return None


def clear_misrouted_composite_errors(db):
    for inst in db.scalars(select(Instrument).where(
            Instrument.source == "composite", Instrument.error == "Unknown source: composite"
    ).with_for_update(skip_locked=True)):
        inst.error = None
        inst.quality = "waiting"
        db.add(Audit(kind="market_routing_repaired", details={
            "instrument": inst.id, "owner": "composite", "quality": "waiting",
        }))


def upsert(db, instrument_id, timeframe, c):
    write_bars(db, instrument_id, timeframe, [c])
    return db.scalar(select(Bar).where(Bar.instrument_id == instrument_id,
        Bar.timeframe == timeframe, Bar.start == ms(c.start)))


def stored_coverage(db, instrument, left, right):
    from .config import settings
    from .coverage_projection import audit_spans, normalize
    if settings.coverage_projection_enabled:
        from .coverage_projection import read
        projected = read(db, instrument, left, right)
        if projected is not None:
            return projected
    coverage = []
    if instrument.source == "oanda":
        db.flush()
        for audit in db.scalars(
            select(Audit).where(
                Audit.kind == "provider_query_coverage",
                Audit.details["instrument"].as_string() == instrument.id,
            )
        ):
            try:
                spans = audit_spans(instrument, audit.details)
            except (ValueError, TypeError, KeyError):
                continue
            coverage.extend(dict(start=a, end=b) for a, b in spans if a < right and b > left)
    for span in db.scalars(
        select(MarketCoverage).where(
            MarketCoverage.instrument_id == instrument.id,
            MarketCoverage.source == instrument.source,
            MarketCoverage.basis == instrument.basis,
            MarketCoverage.start < right,
            MarketCoverage.end > left,
        )
    ):
        try:
            coverage.extend(dict(start=a, end=b) for a, b in normalize(span.start, span.end))
        except (ValueError, TypeError):
            continue
    # Live adapters may query from a sub-minute wall-clock instant. Only full
    # M1 intervals certify maintenance; never leak fractional download cursors.
    return [{'start': (s['start'] + 59999) // 60000 * 60000,
             'end': s['end'] // 60000 * 60000} for s in coverage
            if (s['start'] + 59999) // 60000 * 60000 < s['end'] // 60000 * 60000]


@dataclass(frozen=True)
class Ingestion:
    minutes: int
    price_changed: bool


def ingest(db, instrument, payload, received_at=None, *, defer_aggregation=False, report_changes=False, price_manifest=None):
    # Serialize bounded writes for one instrument across live and history workers.
    from .storage import MarketDataset

    if instrument.id.startswith("MD:"):
        db.scalar(select(MarketDataset.id).where(MarketDataset.instrument_id == instrument.id).with_for_update())
    db.scalar(select(Instrument).where(Instrument.id == instrument.id).with_for_update())
    batch = validate_ingestion(db, instrument, payload, price_manifest=price_manifest)
    if batch is not None:
        # Keep the source payload immutable, but pass the validated business
        # rows to every Bar and aggregation writer.
        payload = {**payload, "rows": [row.model_dump() for row in batch.rows]}
    if batch and payload.get("coverage"):
        raise ValueError("Explicit M1 batches certify observed minutes only")
    if payload.get("source") and payload["source"] != instrument.source:
        raise ValueError("行情来源不匹配，拒绝混合数据")
    if payload.get("basis") and payload["basis"] != instrument.basis:
        raise ValueError("报价口径不匹配，拒绝混合数据")
    received_at = received_at or (batch.observed_at if batch else now_ms())
    if batch:
        db.add(Audit(kind="dataset_batch_ingested", details={
            "dataset": batch.identity.key, "instrument": instrument.id,
            "window_start": batch.window_start, "window_end": batch.window_end,
            "observed_at": batch.observed_at, "request_result": batch.result.status,
            "volume_kind": batch.volume_kind, "volume_unit": batch.volume_unit,
            "returned": len(batch.rows),
        }))
    range_starts = [int(r["timestamp"]) for r in payload["rows"]] + [s["start"] for s in payload.get("coverage", [])]
    previous_coverage = stored_coverage(db, instrument, min(range_starts), received_at) if instrument.source == "oanda" and range_starts else []
    closures = closures_from(instrument.calendar_profile)
    if not batch and any(
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
    # Commit coverage in the same transaction as bars; source empty observations are
    # not a claim of holiday or of the provider's oldest historical boundary.
    spans = payload.get('coverage', [])
    if batch or instrument.source != 'oanda':
        # A successful exchange query with missing minutes cannot certify a
        # continuous range. Persist observed minute spans, merged below.
        from .managed_dataset import _merged
        spans = [{'start': a, 'end': b} for a,b in _merged([
            {'start': int(r['timestamp']), 'end': int(r['timestamp']) + 60000}
            for r in payload['rows'] if not batch or
            (r['complete'] and int(r['timestamp']) + 60000 <= received_at - 5000)])]
    coverage_changed = False
    for span in spans:
        end = min(span["end"], (received_at - 5000) // 60000 * 60000)
        if end <= span["start"]:
            continue
        existing = db.scalar(
            select(MarketCoverage).where(
                MarketCoverage.instrument_id == instrument.id,
                MarketCoverage.source == instrument.source,
                MarketCoverage.basis == instrument.basis,
                MarketCoverage.start == span["start"],
                MarketCoverage.end == end,
            )
        )
        if existing:
            existing.queried_at = received_at
            existing.observed = span.get("returned", 0)
        else:
            coverage_changed = True
            db.add(
                MarketCoverage(
                    instrument_id=instrument.id,
                    source=instrument.source,
                    basis=instrument.basis,
                    start=span["start"],
                    end=end,
                    observed=span.get("returned", 0),
                    queried_at=received_at,
                )
            )
    if coverage_changed:
        from .publication_schedule import COVERAGE, request
        request(db, instrument.id, reason=COVERAGE, stamp=received_at)
        from .coverage_projection import merge
        merge(db, instrument, [(span['start'], min(span['end'], (received_at - 5000) // 60000 * 60000))
                               for span in spans if span['start'] < min(span['end'], (received_at - 5000) // 60000 * 60000)])
    changed = []
    minute_candles = []
    for raw in payload["rows"]:
        start = instant(int(raw["timestamp"]))
        if start.second or start.microsecond:
            raise ValueError("Provider M1 boundary is not a whole minute")
        end = start + timedelta(minutes=1)
        # Exclude forming minute; conservative 5s margin. Provider finality remains a source gate.
        if ms(end) > received_at - 5000:
            continue
        if not raw.get("complete", True):
            continue
        from .volume import quantity
        c = Candle(start, end, *(Decimal(str(raw[k])) for k in ["open", "high", "low", "close"]),
                   volume=quantity(raw.get("volume"), tick=instrument.source == "oanda"),
                   volume_supplied="volume" in raw)
        minute_candles.append(c)
        changed.append(start)
    changes = write_bars(db, instrument.id, "M1", minute_candles, observed_at=received_at)
    if batch:
        conflicts = [ms(c.start) for c in minute_candles if not scheduled_open(
            c.start, calendar_for(instrument), gold=is_gold(instrument.id), closures=closures)]
        if conflicts:
            db.add(Audit(kind="source_session_observation_conflict", details={
                "dataset": batch.identity.key, "calendar_revision": batch.identity.calendar_version,
                "observed_minute_starts": conflicts, "observed_at": received_at,
                "action": "preserve source M1; conflicting closure cannot certify aggregate completeness"}))
    touched = set(changed) if changes.price else set()
    volume_touched = {instant(at) for at in changes.volume}
    if instrument.source == "oanda":
        for span in payload.get("coverage", []):
            cursor = ((span["start"] + 59999) // 60000) * 60000
            cutoff = min(span["end"], received_at - 5000)
            while cursor + 60000 <= cutoff:
                if not covers_interval(previous_coverage, cursor, cursor + 60000):
                    touched.add(instant(cursor))
                cursor += 60000
    if volume_touched:
        if defer_aggregation:
            from .chart_aggregation import enqueue_aggregation
            enqueue_aggregation(db, instrument.id, ms(min(volume_touched)),
                ms(max(volume_touched)) + 60000, received_at, kind="volume")
        else:
            aggregate_touched(db, instrument, volume_touched, received_at=received_at, kind="volume")
    if not touched:
        return Ingestion(len(changed), False) if report_changes else len(changed)
    if defer_aggregation:
        from .chart_aggregation import PERIODS, enqueue_aggregation

        left, right = ms(min(touched)), ms(max(touched)) + 60000
        enqueue_aggregation(db, instrument.id, left, right, received_at)
        # Persist invalidation with the new M1 and queue. Strategy readers must
        # not accept an older aggregate as final while rebuilding is pending.
        db.execute(update(Bar).where(
            Bar.instrument_id == instrument.id, Bar.timeframe.in_(PERIODS),
            Bar.start < right, Bar.end > left).values(
                complete=False, revision=Bar.revision+1, received_at=received_at))
    else:
        aggregate_touched(db, instrument, touched, received_at=received_at)
    return Ingestion(len(changed), True) if report_changes else len(changed)


def aggregate_touched(db, instrument, touched, *, received_at=None,
                      timeframes=("M5", "M15", "H1", "H4", "D1"), kind="price"):
    """Rebuild selected periods from persisted M1, without fetching or altering M1.

    Callers may process one period in a short independent transaction. The
    instrument lock serializes revisions with live ingestion of the same bars.
    """
    timeframes = tuple(dict.fromkeys(timeframes))
    if any(frame not in {"M5", "M15", "H1", "H4", "D1"} for frame in timeframes):
        raise ValueError("Unsupported persisted aggregate timeframe")
    if not touched or not timeframes:
        return
    db.scalar(select(Instrument).where(Instrument.id == instrument.id).with_for_update())
    received_at = received_at or now_ms()
    closures = closures_from(instrument.calendar_profile)
    calendar = calendar_for(instrument)
    earliest = min(ms(bucket_bounds(min(touched), frame, calendar)[0]) for frame in timeframes)
    latest_boundary = max(ms(bucket_bounds(max(touched), frame, calendar)[1]) for frame in timeframes)
    coverage = stored_coverage(db, instrument, earliest, latest_boundary)
    # Read each touched day once rather than issuing one query per aggregate bar.
    minute_rows = db.scalars(
        select(Bar)
        .where(
            Bar.instrument_id == instrument.id,
            Bar.timeframe == "M1",
            Bar.start >= earliest,
            Bar.start < latest_boundary,
        )
        .order_by(Bar.start)
    ).all()
    from .publication_budget import current
    if current():
        current().consume(len(minute_rows))
    calendar = calendar_for(instrument)
    for timeframe in timeframes:
        bounds = {bucket_bounds(t, timeframe, calendar) for t in touched}
        grouped = {}
        for row in minute_rows:
            pair = bucket_bounds(instant(row.start), timeframe, calendar)
            if pair in bounds:
                grouped.setdefault(pair, []).append(row)
        outputs = []
        for left, right in sorted(bounds):
            rows = grouped.get((left, right), [])
            conflicted = instrument.id.startswith("MD:") and any(not scheduled_open(
                instant(row.start), calendar, gold=is_gold(instrument.id), closures=closures) for row in rows)
            if coverage and covers_interval(coverage, ms(left), ms(right)):
                # Fully queried sparse observations need no calendar enumeration.
                expected = {instant(r.start) for r in rows}
            else:
                expected = set()
                t = left
                while t < right:
                    if conflicted or scheduled_open(
                        t,
                        calendar,
                        gold=is_gold(instrument.id),
                        closures=closures,
                    ):
                        expected.add(t)
                    t += timedelta(minutes=1)
            c = aggregate([r.candle() for r in rows], left, right, expected_starts=expected)
            if c:
                complete = c.complete and bool(expected) and ms(right) <= received_at - 5000
                from dataclasses import replace

                from .volume import total
                observed_expected = {t for t in expected if ms(t)+60000 <= received_at-5000}
                amount = total(rows) if observed_expected <= {instant(r.start) for r in rows} else None
                if ms(right) <= received_at-5000 and not c.complete:
                    amount = None
                c = replace(c, volume=amount)
                c = replace(c, complete=complete, volume_complete=complete and c.volume_complete)
                outputs.append(c)
        if kind in ("volume", "observed"):
            # Never pair a new quantity with staging prices being repaired.
            from .storage import ChartAggregationJob
            if db.scalar(select(ChartAggregationJob.id).where(
                    ChartAggregationJob.instrument_id == instrument.id,
                    ChartAggregationJob.timeframe == timeframe,
                    ChartAggregationJob.kind == "price",
                    ChartAggregationJob.start < latest_boundary,
                    ChartAggregationJob.end > earliest).limit(1)):
                continue
        if kind == 'observed':
            for candle in outputs:
                members = grouped[(candle.start, candle.end)]
                write_bars(db, instrument.id, timeframe, [candle],
                    observed_at=max(row.observed_at for row in members),
                    authoritative_volume=True, observation_only=True)
        else:
            write_bars(db, instrument.id, timeframe, outputs, observed_at=received_at,
                       volume_only=kind == "volume", authoritative_volume=True)



def enqueue_repair(db, instrument, left, right, *, recent_end=None):
    """Only the last 24h of a gap is realtime repair; older work stays history."""
    from .market_data import missing_intervals

    if left >= right:
        return
    recent_end = recent_end if recent_end is not None else (now_ms() - 5000) // 60000 * 60000
    recent_start = recent_end - 24 * 60 * 60000
    calendar = calendar_for(instrument)
    closures = closures_from(instrument.calendar_profile)
    for start, end, priority in ((left, min(right, recent_start), 50),
                                  (max(left, recent_start), right, 0)):
        if end <= start:
            continue
        from .chart_history_plan import bucket_has_trading
        if not bucket_has_trading(instant(start), instant(end), calendar,
                                  is_gold(instrument.id), closures):
            continue
        # A history reservation must never block a separate recent repair or
        # be promoted wholesale into the realtime executor.
        jobs = list(db.scalars(select(ImportJob).where(
            ImportJob.instrument_id == instrument.id, ImportJob.priority == priority,
            ImportJob.cursor < end, ImportJob.end > start,
            ImportJob.status.in_(['pending', 'running', 'failed']))))
        reserved = stored_coverage(db, instrument, start, end) + [
            {'start': j.cursor, 'end': j.end} for j in jobs]
        for a, b in missing_intervals(reserved, start, end):
            # Bound each lease and writer lock, including recovery after days offline.
            for cursor in range(a, b, 120 * 60000):
                stop = min(b, cursor + 120 * 60000)
                db.add(ImportJob(instrument_id=instrument.id, start=cursor,
                    end=stop, cursor=cursor, priority=priority))
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
        enqueue_repair(db, instrument, previous_end, left, recent_end=cutoff)
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
            enqueue_repair(db, instrument, cursor, at, recent_end=cutoff)
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
        ordinary_instruments().where(Instrument.enabled.is_(True)).with_for_update()
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


def once(symbol=None, start=None, end=None, *, include_viewers=False, fetcher=None,
         source_filter=None):
    fetch = fetcher or fetch_source
    with transaction() as db:
        clear_misrouted_composite_errors(db)
        viewers = set()
        if include_viewers:
            from .realtime_switch import enabled, revision_instrument_id
            from .storage import (
                ChartHistoryPlan,
                ChartViewportDemand,
                CompositeRevision,
                MarketComposite,
                MarketDemand,
            )

            viewers.update(db.scalars(select(ChartHistoryPlan.instrument_id).where(
                ChartHistoryPlan.realtime_enabled.is_(True))))
            for ident, in db.execute(select(MarketDemand.instrument_id).where(MarketDemand.expires > now_ms())):
                composite = db.scalar(select(MarketComposite).where(MarketComposite.instrument_id == ident))
                if composite:
                    revision = db.get(CompositeRevision, composite.active_revision_id)
                    source_id = revision_instrument_id(db, revision) if revision else None
                    if source_id and enabled(db, source_id):
                        viewers.add(ident)
                elif enabled(db, ident):
                    viewers.add(ident)
            viewers.update(ident for ident, in db.execute(select(ChartViewportDemand.instrument_id).where(
                ChartViewportDemand.expires > now_ms())) if enabled(db, ident))
        instruments = [
            (i.id, i.symbol, i.source)
            for i in db.scalars(ordinary_instruments().order_by(Instrument.enabled.desc(), Instrument.id))
            if (i.id == symbol if symbol else i.enabled or i.id in viewers)
            and (source_filter is None or i.source in source_filter)
        ]
    for instrument_id, provider_symbol, source in instruments:
        with transaction() as db:
            backoff = db.get(Preference, f"market_backoff:{source}")
            if backoff and backoff.value.get("until", 0) > now_ms():
                continue
        try:
            payload = fetch(source, provider_symbol, start, end)
            with transaction() as db:
                inst = db.get(Instrument, instrument_id)
                if not start:
                    queue_recovery(db, inst, payload)
                ingestion = ingest(db, inst, payload, report_changes=True)
                count = ingestion.minutes
                db.add(
                    Audit(
                        kind="market_ingested",
                        details={"instrument": instrument_id, "minutes": count},
                    )
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
        except (RuntimeError, ValueError, TimeoutError, subprocess.TimeoutExpired, OSError, httpx.HTTPError) as e:
            from .provider_transport import error_detail
            detail = error_detail(e)
            with transaction() as db:
                inst = db.get(Instrument, instrument_id)
                inst.quality = "error"
                inst.error = detail
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
                        details={"instrument": instrument_id, "error": detail,
                                 "error_type": type(e).__name__},
                    )
                )
    with transaction() as db:
        db.add(Audit(kind="market_heartbeat", details={}))


def import_once(*, chart_only=False, fetcher=None, defer_aggregation=False,
                realtime_only=False, history_only=False, source_filter=None):
    """One daily slice per iteration. Durable cursor and lease permit safe restart."""
    with transaction() as db:
        from .storage import ChartAggregationJob

        live_instruments = realtime_instruments()
        if history_only and db.scalar(select(ImportJob.id).where(
                ImportJob.priority == 0, ImportJob.instrument_id.in_(live_instruments),
                ImportJob.status.in_(['pending', 'running'])).limit(1)):
            return False
        # One history downloader feeds the independent aggregation executor.
        # Bound ready CPU work without throttling live M1 ingestion. Failed
        # slices retain their durable retry state but must not exhaust capacity
        # for unrelated symbols. Also bound each symbol including failed work.
        if defer_aggregation and db.scalar(select(func.count()).select_from(
                ChartAggregationJob).where(ChartAggregationJob.error.is_(None))) >= 60:
            return False
        saturated_symbols = select(ChartAggregationJob.instrument_id).group_by(
            ChartAggregationJob.instrument_id).having(func.count() >= 60)
        # Skip all jobs of a cooling-down source in the selection query, rather
        # than spending one worker iteration deferring each of its queued jobs.
        cooling_sources = [
            preference.key.removeprefix("market_backoff:")
            for preference in db.scalars(
                select(Preference).where(Preference.key.like("market_backoff:%"))
            )
            if preference.value.get("until", 0) > now_ms()
        ]
        job = db.scalar(
            select(ImportJob)
            .where(
                ImportJob.instrument_id.not_in(saturated_symbols) if defer_aggregation else True,
                ImportJob.instrument_id.in_(
                    ordinary_instruments().with_only_columns(Instrument.id).where(
                        Instrument.source.not_in(cooling_sources),
                        (Instrument.source.in_(source_filter) if source_filter is not None else True))
                ),
                ImportJob.next_at <= now_ms(),
                ImportJob.priority == 0 if realtime_only else True,
                or_(ImportJob.priority > 0, ImportJob.instrument_id.in_(live_instruments)),
                ImportJob.priority > 0 if history_only else True,
                ImportJob.priority >= 100 if chart_only else ImportJob.priority < 100,
                or_(
                    ImportJob.status == "pending",
                    (ImportJob.status == "running") & (ImportJob.lease_until < now_ms()),
                ),
            )
            .order_by(
                ImportJob.priority,
                # Each chart page advances next_at. Serve the oldest eligible
                # request before returning to a large, more recent import.
                ImportJob.next_at if chart_only else ImportJob.start.desc(),
                ImportJob.created_at,
            )
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
            min(job.end, job.cursor + (120 if realtime_only else 600) * 60000)
            if chart_only or realtime_only or history_only
            else min(job.end, ((job.cursor // 86400_000) + 1) * 86400_000),
        )
    started = time.monotonic()
    fetch_finished = None
    try:
        payload = (fetcher or fetch_source)(
            source, symbol, instant(left).isoformat(), instant(right).isoformat()
        )
        fetch_finished = time.monotonic()
        if chart_only:
            logging.info("chart_history_fetch source=%s symbol=%s minutes=%d rows=%d seconds=%.3f",
                         source, symbol, (right-left)//60000, len(payload["rows"]), fetch_finished-started)
        with transaction() as db:
            # Planner/control paths lock the instrument before updating jobs.
            # Match that order to avoid a job->instrument / instrument->job cycle.
            instrument_id = db.scalar(select(ImportJob.instrument_id).where(ImportJob.id == ident))
            db.scalar(select(Instrument).where(Instrument.id == instrument_id).with_for_update())
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
                        calendar_for(inst),
                        gold=is_gold(inst.id),
                        closures=closures_from(inst.calendar_profile),
                    ):
                        raise ValueError("交易时段返回空数据，保留补数游标等待重试")
                    t += timedelta(minutes=1)
            inst = db.get(Instrument, job.instrument_id)
            ingest(db, inst, payload, defer_aggregation=defer_aggregation)
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
                        calendar_for(inst),
                        gold=is_gold(inst.id),
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
    except (RuntimeError, ValueError, TimeoutError, subprocess.TimeoutExpired, OSError, httpx.HTTPError) as e:
        with transaction() as db:
            # Planner/control paths lock the instrument before updating jobs.
            # Match that order to avoid a job->instrument / instrument->job cycle.
            instrument_id = db.scalar(select(ImportJob.instrument_id).where(ImportJob.id == ident))
            db.scalar(select(Instrument).where(Instrument.id == instrument_id).with_for_update())
            job = db.scalar(select(ImportJob).where(ImportJob.id == ident).with_for_update())
            if job.status != "running" or job.lease_until != lease or job.cursor != left:
                return True
            job.error = str(e)[-600:] or type(e).__name__
            job.attempts += 1
            job.status = "failed" if job.attempts >= 5 else "pending"
            job.lease_until = None
            job.next_at = now_ms() + min(600, 30 * 2**job.attempts) * 1000
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code == 429:
                from email.utils import parsedate_to_datetime

                retry_after = e.response.headers.get("Retry-After", "")
                until = now_ms() + 300_000
                try:
                    until = max(until, now_ms() + int(retry_after) * 1000)
                except ValueError:
                    try:
                        until = max(until, int(parsedate_to_datetime(retry_after).timestamp() * 1000))
                    except (ValueError, TypeError, OverflowError):
                        pass
                delay = db.get(Preference, f"market_backoff:{source}")
                if delay:
                    until = max(until, delay.value.get("until", 0))
                    delay.value = {"until": until}
                else:
                    db.add(Preference(key=f"market_backoff:{source}", value={"until": until}))
                job.next_at = max(job.next_at, until)
            if chart_only:
                # Exception messages may contain account URLs; log the class only.
                logging.warning(
                    "chart_history_failure source=%s symbol=%s error_type=%s attempt=%d status=%s",
                    source, symbol, type(e).__name__, job.attempts, job.status,
                )
    finally:
        if chart_only:
            finished = time.monotonic()
            logging.info("chart_history_page source=%s symbol=%s total_seconds=%.3f ingest_seconds=%s",
                         source, symbol, finished-started,
                         round(finished-fetch_finished, 3) if fetch_finished is not None else "not_started")
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
        from .worker_health import Pulse

        pulse = Pulse("legacy_import")
        with transaction() as db:
            queue_initial_history(db)
        while True:
            pulse.start()
            import_once()
            with transaction() as db:
                db.add(Audit(kind="import_heartbeat", details={}))
            pulse.finish()
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
