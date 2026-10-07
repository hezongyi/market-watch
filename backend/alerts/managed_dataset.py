"""Explicit maintenance and immutable published candle snapshots.

Acquisition writes ordinary candles as staging. A publisher copies only covered,
finished results in bounded transactions; readers never see unfinished revisions.
"""

import hashlib
import json
from datetime import UTC, date, datetime, time, timedelta
from math import ceil

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .chart_data import FRAMES, bounds, chart_rows
from .coverage import covers_interval
from .domain import NY, Calendar, bucket_bounds, calendar_for
from .storage import (
    Bar,
    ChartAggregationJob,
    ChartHistoryPlan,
    ChartPublication,
    ChartPublicationJob,
    ChartPublishedBar,
    Instrument,
    instant,
    ms,
    now_ms,
    transaction,
)

BATCH = 2000
_PUBLISH_CURSOR = None


def date_start(inst, value):
    """Date denotes a trading date, including NY17's previous-day session start."""
    day = date.fromisoformat(value)
    if inst.calendar == Calendar.NY17.value:
        moment = datetime.combine(day - timedelta(days=1), time(17), NY)
    else:
        moment = datetime.combine(day, time(), UTC)
    return ms(moment)


def join(db, inst, start, now):
    end = (now - 5000) // 60000 * 60000
    if start < 0 or start % 60000 or start >= end:
        raise ValueError("历史起点必须早于最新已完成分钟")
    db.scalar(select(Instrument).where(Instrument.id == inst.id).with_for_update())
    plan = db.get(ChartHistoryPlan, inst.id)
    if plan is None:
        plan = ChartHistoryPlan(
            instrument_id=inst.id,
            target_start=start,
            target_end=end,
            cursor=end,
            realtime_enabled=True,
            status="pending",
            updated_at=now,
        )
        db.add(plan)
    else:
        from .chart_history_plan import boundary_context, control_plan
        from .storage import Preference

        boundary = db.get(Preference, "chart_history_boundary:" + inst.id)
        proof = boundary.value if boundary else {}
        correct_unreachable = (
            proof.get("earliest") is not None
            and all(proof.get(k) == v for k, v in boundary_context(inst, plan.target_start).items())
            and plan.target_start < proof["earliest"] <= start
        )
        earlier = start < plan.target_start
        if correct_unreachable:
            # A new explicit submission may repair an impossible legacy target.
            # This is the sole forward adjustment; browsing never authorizes it.
            control_plan(db, inst.id, "retry", now)
            plan.target_start = start
            plan.target_end = max(plan.target_end, end)
            plan.cursor = plan.target_end
        else:
            plan.target_start = min(plan.target_start, start)
        # Keep the original initialization endpoint stable. Future M1 is live work.
        if earlier or plan.status == "cancelled":
            plan.status = "pending"
        plan.realtime_enabled = True
        plan.updated_at = now
    inst.enabled = True
    db.flush()
    return plan


def _merged(spans):
    result = []
    for span in sorted(spans, key=lambda s: s["start"]):
        a, b = span["start"], span["end"]
        if b <= a:
            continue
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def continuous_coverage(db, inst, plan, now):
    from .market import stored_coverage

    cutoff = (now - 5000) // 60000 * 60000
    spans = _merged(stored_coverage(db, inst, plan.target_start, cutoff))
    spans = [
        (max(a, plan.target_start), min(b, cutoff))
        for a, b in spans
        if b > plan.target_start and a < cutoff
    ]
    # Only the most recent continuous interval is the live dataset. Other
    # intervals are reported separately; no artificial join across a gap.
    return spans


def _source(frame):
    return "M15" if frame == "M30" else "D1" if frame in ("W1", "MN") else frame


def _bounds(at, frame, inst):
    calendar = calendar_for(inst)
    return (bounds if frame in ("M30", "W1", "MN") else bucket_bounds)(instant(at), frame, calendar)


def publish_corrections(db, inst, pub, frame, left, right, pending, now):
    """Reconcile one dirty page without moving the published coverage edges."""
    if pub is None:
        return
    jobs = list(db.scalars(select(ChartPublicationJob).where(
        ChartPublicationJob.instrument_id == inst.id,
        ChartPublicationJob.timeframe == frame,
        or_(
            and_(ChartPublicationJob.start >= max(left, pub.start),
                 ChartPublicationJob.start < min(right, pub.end)),
            select(ChartPublishedBar.start).where(
                ChartPublishedBar.instrument_id == inst.id,
                ChartPublishedBar.timeframe == frame,
                ChartPublishedBar.start == ChartPublicationJob.start,
                ChartPublishedBar.complete.is_(True),
            ).exists(),
        ),
        ~select(ChartAggregationJob.id).where(
            ChartAggregationJob.instrument_id == inst.id,
            ChartAggregationJob.timeframe == _source(frame),
            ChartAggregationJob.start < ChartPublicationJob.end,
            ChartAggregationJob.end > ChartPublicationJob.start,
        ).exists(),
    ).order_by(ChartPublicationJob.start.desc()).limit(BATCH)))
    if not jobs:
        return
    queued = {job.start: job for job in jobs}
    rows = chart_rows(db, inst, frame, jobs[0].end, BATCH, now, observed=True)
    existing = {row.start: row for row in db.scalars(select(ChartPublishedBar).where(
        ChartPublishedBar.instrument_id == inst.id,
        ChartPublishedBar.timeframe == frame,
        ChartPublishedBar.start.in_([row["start"] for row in rows]),
    ))}
    for row in rows:
        job = queued.get(row["start"])
        old = existing.get(row["start"])
        if (old is None or not old.complete) and (row["start"] < max(left, pub.start) or row["start"] >= min(right, pub.end)):
            continue
        if any(j.start < row["end"] and j.end > row["start"] for j in pending):
            continue
        if not row["complete"] and (row["end"] <= now or old is not None and old.complete):
            continue
        # A forming bucket still needs a covered prefix; don't publish missing history.
        complete = row["complete"] if old is not None else row["complete"] and row["end"] <= right
        row = {**row, "complete": complete,
               "volume_complete": complete and row.get("volume_complete", False)}
        if old is None:
            # New observations inside proven coverage are legitimate corrections.
            db.add(ChartPublishedBar(instrument_id=inst.id, timeframe=frame,
                                     start=row["start"], end=row["end"],
                                     complete=row["complete"], payload=row, revision=1))
            pub.complete_count += int(row["complete"])
            pub.revision += 1
        elif old.payload != row:
            pub.complete_count += int(row["complete"]) - int(old.complete)
            old.end, old.complete, old.payload = row["end"], row["complete"], row
            old.revision += 1
            pub.revision += 1
        if job is not None:
            db.delete(job)
    db.flush()


def publish_frame(db, inst, plan, frame, now):
    spans = continuous_coverage(db, inst, plan, now)
    if not spans:
        pub = db.get(ChartPublication, (inst.id, frame))
        if pub:
            # No current coverage proof permits new snapshots, but confirmed
            # historical snapshots still accept independent revisions.
            publish_corrections(db, inst, pub, frame, 0, 0, [], now)
        return False
    left, right = spans[-1]
    plan.realtime_end = max(plan.realtime_end, right)
    pub = db.get(ChartPublication, (inst.id, frame))
    # Ceil the approved/covered start; a truncated historical bucket stays hidden.
    a, b = map(ms, _bounds(left, frame, inst))
    safe_left = left if a == left else b
    source = _source(frame)
    pending = list(
        db.scalars(
            select(ChartAggregationJob).where(
                ChartAggregationJob.instrument_id == inst.id,
                ChartAggregationJob.timeframe == source,
                ChartAggregationJob.end > safe_left,
                ChartAggregationJob.start < right,
            )
        )
    )
    publish_corrections(db, inst, pub, frame, left, right, pending, now)
    if pending:
        # A pending slice is a barrier: publish only the completed suffix on
        # its right, retaining previous snapshots on its left unchanged.
        safe_left = max(safe_left, max(ms(_bounds(j.end - 1, frame, inst)[1]) for j in pending))
    # Read bounded pages at the historical edge and at the live edge. Source
    # OHLC can change in staging without mutating the published snapshot.
    tail = chart_rows(db, inst, frame, right, BATCH, now, observed=True)
    older = chart_rows(db, inst, frame, pub.start, BATCH, now, observed=True) if pub else []
    candidates = {row["start"]: row for row in older + tail}
    rows = []
    for row in sorted(candidates.values(), key=lambda r: r["start"]):
        if row["start"] < safe_left or row["start"] >= right:
            continue
        if any(j.start < row["end"] and j.end > row["start"] for j in pending):
            continue
        stop = min(row["end"], right)
        if not covers_interval([{"start": left, "end": right}], row["start"], stop):
            continue
        if row["end"] <= right and not row["complete"]:
            continue
        # An unclosed bucket needs complete prefix coverage and completed source
        # aggregation. It is deliberately excluded from the opening count.
        row = {**row, "complete": row["complete"] and row["end"] <= right}
        rows.append(row)
    if not rows:
        # Complete empty queried ranges still resolve initialization, not candles.
        if not pending and left <= plan.target_start and right >= plan.target_end:
            if pub is None:
                pub = ChartPublication(
                    instrument_id=inst.id,
                    timeframe=frame,
                    start=safe_left,
                    end=right,
                    complete_count=0,
                    revision=1,
                    initialized=left <= plan.target_start and right >= plan.target_end,
                    updated_at=now,
                )
                db.add(pub)
            elif left <= plan.target_start and right >= plan.target_end:
                pub.initialized = True
        return False
    # Do not publish disconnected older slices while a newer source segment is
    # still being generated. The current suffix may open independently by frame.
    safe_rows = []
    for row in reversed(rows):
        if safe_rows and any(
            j.start < safe_rows[-1]["start"] and j.end > row["end"] for j in pending
        ):
            break
        safe_rows.append(row)
    rows = safe_rows[::-1]
    first = rows[0]["start"]
    predecessor = db.scalar(
        select(Bar.start)
        .where(
            Bar.instrument_id == inst.id,
            Bar.timeframe == source,
            Bar.start >= safe_left,
            Bar.start < first,
        )
        .limit(1)
    )
    coverage_start = safe_left if predecessor is None else first
    # A bounded bootstrap must not announce coverage before all its candle rows
    # have been copied. Each later pass extends the older edge by another page.
    if pub is None:
        pub = ChartPublication(
            instrument_id=inst.id,
            timeframe=frame,
            start=coverage_start,
            end=right,
            complete_count=0,
            revision=0,
            initialized=False,
            updated_at=now,
        )
        db.add(pub)
    elif first > pub.end:
        # Recovery after a genuine gap needs its own interval; keep existing
        # publication until the missing interval has been repaired.
        return False
    old_start, old_end = pub.start, pub.end
    existing = {
        r.start: r.payload
        for r in db.scalars(
            select(ChartPublishedBar).where(
                ChartPublishedBar.instrument_id == inst.id,
                ChartPublishedBar.timeframe == frame,
                ChartPublishedBar.start.in_([r["start"] for r in rows]),
            )
        )
    }
    changed = any(existing.get(r["start"]) != r for r in rows)
    values = [
        dict(
            instrument_id=inst.id,
            timeframe=frame,
            start=r["start"],
            end=r["end"],
            complete=r["complete"],
            payload=r,
        )
        for r in rows
        if existing.get(r["start"]) != r
    ]
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    statement = insert(ChartPublishedBar.__table__)
    statement = statement.on_conflict_do_update(
        index_elements=["instrument_id", "timeframe", "start"],
        set_={**{k: getattr(statement.excluded, k) for k in ("end", "complete", "payload")},
              "revision": ChartPublishedBar.revision + 1},
    )
    if values:
        db.execute(statement, values)
    pub.start = min(pub.start, coverage_start)
    pub.end = max(pub.end, right)
    pub.complete_count = db.scalar(
        select(func.count())
        .select_from(ChartPublishedBar)
        .where(
            ChartPublishedBar.instrument_id == inst.id,
            ChartPublishedBar.timeframe == frame,
            ChartPublishedBar.start >= pub.start,
            ChartPublishedBar.end <= pub.end,
            ChartPublishedBar.complete.is_(True),
        )
    )
    init_bucket = map(ms, _bounds(plan.target_start, frame, inst))
    init_left, init_right = init_bucket
    needed_left = init_left if init_left == plan.target_start else init_right
    pub.initialized = (
        left <= plan.target_start
        and right >= plan.target_end
        and pub.start <= needed_left
        and not pending
    )
    # A revision denotes a visible snapshot change, not network/download state.
    if changed or old_start != pub.start or old_end != pub.end:
        pub.revision += 1
    pub.updated_at = now
    db.flush()
    return old_start != pub.start or old_end != pub.end


def publish_once():
    """One bounded publication per aggregation turn, fair across all datasets.

    Publication records persist each edge; the in-memory rotation only chooses
    the next turn. Restarting can repeat a page without losing progress. Advance
    the cursor before work so a failing period cannot starve healthy periods.
    """
    global _PUBLISH_CURSOR
    adopt_legacy_once()
    with transaction() as db:
        ids = sorted(set(db.scalars(select(ChartHistoryPlan.instrument_id))) |
                     set(db.scalars(select(ChartPublication.instrument_id))))
    targets = [(ident, frame) for ident in ids for frame in FRAMES]
    if not targets:
        _PUBLISH_CURSOR = None
        return False
    position = (targets.index(_PUBLISH_CURSOR) + 1) % len(targets) if _PUBLISH_CURSOR in targets else 0
    ident, frame = _PUBLISH_CURSOR = targets[position]
    with transaction() as db:
        inst = db.scalar(select(Instrument).where(Instrument.id == ident).with_for_update())
        plan = db.get(ChartHistoryPlan, ident)
        if plan:
            publish_frame(db, inst, plan, frame, now_ms())
        else:
            pub = db.get(ChartPublication, (ident, frame))
            if pub:
                publish_corrections(db, inst, pub, frame, pub.start, pub.end, [], now_ms())
    return True


def adopt_legacy_once():
    """Expose already verified legacy history without acquiring new history.

    Built-in instruments already maintained before this feature retain their
    maintenance setting. A disabled catalog entry with no stored coverage is
    never adopted merely because somebody searched or opened its chart.
    """
    from .market import stored_coverage
    from .storage import MarketCoverage

    with transaction() as db:
        ids = list(
            db.scalars(
                select(Instrument.id).where(
                    Instrument.id.not_in(select(ChartHistoryPlan.instrument_id)),
                    Instrument.id.in_(select(MarketCoverage.instrument_id)),
                )
            )
        )
    for ident in ids:
        with transaction() as db:
            inst = db.scalar(select(Instrument).where(Instrument.id == ident).with_for_update())
            if db.get(ChartHistoryPlan, ident):
                continue
            spans = list(
                db.scalars(
                    select(MarketCoverage).where(
                        MarketCoverage.instrument_id == ident,
                        MarketCoverage.source == inst.source,
                        MarketCoverage.basis == inst.basis,
                    )
                )
            )
            if not spans:
                continue
            # Use the same complete-minute proof as the publisher. Old live
            # queries can start at millisecond wall-clock instants; adopting
            # their raw endpoints makes initialization permanently unreachable.
            coverage = stored_coverage(
                db, inst, min(s.start for s in spans), max(s.end for s in spans)
            )
            if not coverage:
                continue
            left = min(s["start"] for s in coverage)
            right = max(s["end"] for s in coverage)
            complete = covers_interval(coverage, left, right)
            db.add(
                ChartHistoryPlan(
                    instrument_id=ident,
                    target_start=left,
                    target_end=right,
                    cursor=left if complete else right,
                    status="complete" if complete else "cancelled",
                    realtime_enabled=inst.enabled,
                    realtime_end=right,
                    updated_at=now_ms(),
                )
            )


def status(db, inst, frame, *, width=960, spacing=6, lookback=0):
    if frame not in FRAMES or not 0 < width <= 16384 or not 0 < spacing <= 1000:
        raise ValueError("无效图表尺寸或周期")
    plan = db.get(ChartHistoryPlan, inst.id)
    pub = db.get(ChartPublication, (inst.id, frame))
    threshold = 3 * ceil(width / spacing)
    count = pub.complete_count if pub else 0
    # lookback is additional to the first visible screen. Completed approved
    # history permits fewer candles, but does not invent indicator history.
    indicator_ready = count >= ceil(width / spacing) + lookback if lookback else True
    ready = bool(pub and count and (count >= threshold or pub.initialized) and indicator_ready)
    return dict(
        instrument=inst.id,
        timeframe=frame,
        target_start=plan.target_start if plan else None,
        plot_width=width,
        bar_spacing=spacing,
        initialization_end=plan.target_end if plan else None,
        cursor=plan.cursor if plan else None,
        history_status=plan.status if plan else "unmaintained",
        realtime_enabled=plan.realtime_enabled if plan else inst.enabled,
        realtime_end=plan.realtime_end if plan else 0,
        start=pub.start if pub else None,
        end=pub.end if pub else None,
        revision=pub.revision if pub else 0,
        complete_count=count,
        threshold=threshold,
        ready=ready,
        initialized=bool(pub and pub.initialized),
        indicator_ready=indicator_ready,
        reason=(
            "ready"
            if ready
            else "unmaintained"
            if plan is None
            else "indicator_history"
            if not indicator_ready
            else "no_complete_bars"
            if pub and pub.initialized and not count
            else "preparing"
        ),
    )


def read_rows(db, inst, frame, before, limit, *, dataset_start=None):
    pub = db.get(ChartPublication, (inst.id, frame))
    if pub is None:
        return []
    left = max(pub.start, dataset_start or pub.start)
    return [
        row.payload
        for row in db.scalars(
            select(ChartPublishedBar)
            .where(
                ChartPublishedBar.instrument_id == inst.id,
                ChartPublishedBar.timeframe == frame,
                ChartPublishedBar.start >= left,
                ChartPublishedBar.start < before,
                ChartPublishedBar.start < pub.end,
            )
            .order_by(ChartPublishedBar.start.desc())
            .limit(limit)
        ).all()[::-1]
    ]


def published_history_check(db, inst, pub, visible, body):
    """Fingerprint a stable session prefix, excluding appends and the streamed last bar."""
    if not body.track_history or not visible or pub is None:
        return None
    next_before = visible[-1]["start"]
    before = body.revision_before or next_before
    after = body.revision_after
    lower = after or 0
    if after is not None and body.timeframe in ("D1", "W1", "MN"):
        # The datafeed reports UTC trading-date labels; published keys are session opens.
        lower = date_start(inst, instant(after).date().isoformat())
    lower = max(pub.start, body.dataset_start or pub.start, lower)

    def fingerprint(boundary):
        stamp = db.execute(select(
            func.count(ChartPublishedBar.start), func.sum(ChartPublishedBar.revision)
        ).where(
            ChartPublishedBar.instrument_id == inst.id,
            ChartPublishedBar.timeframe == body.timeframe,
            ChartPublishedBar.start >= lower,
            ChartPublishedBar.start < min(boundary, pub.end),
        )).one()
        return hashlib.sha256(json.dumps(list(stamp)).encode()).hexdigest()

    revision = fingerprint(before)
    return dict(before=before, after=after, revision=revision, next_before=next_before,
                next_revision=revision if before == next_before else fingerprint(next_before))


def data(body):
    from .chart_calculation_history import calculation_rows
    from .chart_data import future_grid
    from .chart_indicators import calculate

    with transaction() as db:
        inst = db.get(Instrument, body.instrument)
        if inst is None:
            from fastapi import HTTPException

            raise HTTPException(404, "品种不存在")
        pub = db.get(ChartPublication, (inst.id, body.timeframe))
        before = body.before or now_ms() + 1
        # Recursive algorithms use only the selected published dataset prefix;
        # backfill never extends the user's approved start as an indicator side effect.
        count = (
            db.scalar(
                select(func.count())
                .select_from(ChartPublishedBar)
                .where(
                    ChartPublishedBar.instrument_id == inst.id,
                    ChartPublishedBar.timeframe == body.timeframe,
                )
            )
            if body.indicators
            else body.limit + 1
        )
        rows = read_rows(
            db, inst, body.timeframe, before, max(1, count), dataset_start=body.dataset_start
        )
        visible = rows[-body.limit :]
        left = max(pub.start, body.dataset_start or pub.start) if pub else None
        revision = pub.revision if pub else 0
        from .volume import metadata
        volume_meta = metadata(inst.source, inst.symbol)
        basis, calendar, precision = inst.basis, inst.calendar, inst.precision
        future = future_grid(inst, body.timeframe, visible[-1]["end"]) if visible else []
        history_check = published_history_check(db, inst, pub, visible, body)
        calculation_meta = {"calendar": inst.calendar, "calendar_profile": inst.calendar_profile}
    rows = calculation_rows(rows, calculation_meta, body.instrument)
    indicators = []
    for spec in body.indicators:
        result = calculate(rows, spec, provisional=body.provisional)
        start = visible[0]["start"] if visible else before
        indicators.append(
            {
                **result,
                "id": spec.get("id", spec["name"]),
                "series": [
                    {
                        **series,
                        "values": [v for v in series["values"] if start <= v["time"] < before],
                    }
                    for series in result["series"]
                ],
            }
        )
    return dict(
        **volume_meta,
        bars=visible,
        indicators=indicators,
        origin=left,
        has_more=len(rows) > body.limit,
        bounded_history=True,
        history_revision=str(revision),
        history_check=history_check,
        future=future,
        basis=basis,
        calendar=calendar,
        precision=precision,
        as_of=now_ms(),
    )
