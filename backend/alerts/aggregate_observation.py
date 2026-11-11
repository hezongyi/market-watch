"""Refresh proven, unchanged aggregate observations without rebuilding coverage."""

from sqlalchemy import select

from .domain import bucket_bounds, calendar_for
from .storage import Bar, ChartAggregationJob, instant, ms
from .volume import total


def refresh(db, instrument, touched, frame, rows):
    """Caller owns Instrument. Return minutes still needing the full calculation.

    A completed aggregate is its retained completeness proof. Compare bounded
    scalar M1 contents before using that proof; pending content repairs, missing
    aggregates and incomplete buckets remain on the ordinary calculation path.
    """
    calendar = calendar_for(instrument)
    buckets = {}
    for at in touched:
        left, right = bucket_bounds(at, frame, calendar)
        buckets.setdefault((ms(left), ms(right)), set()).add(at)
    left, right = min(a for a, _ in buckets), max(b for _, b in buckets)
    pending = list(db.execute(select(ChartAggregationJob.start, ChartAggregationJob.end).where(
        ChartAggregationJob.instrument_id == instrument.id,
        ChartAggregationJob.timeframe == frame, ChartAggregationJob.kind != 'observed',
        ChartAggregationJob.start < right, ChartAggregationJob.end > left)))
    targets = list(db.scalars(select(Bar).where(Bar.instrument_id == instrument.id,
        Bar.timeframe == frame, Bar.complete.is_(True), Bar.start.in_([a for a, _ in buckets]))))
    targets = [row for row in targets if (row.start, row.end) in buckets and not any(
        a < row.end and b > row.start for a, b in pending)]
    if not targets:
        return touched
    # Reuse the caller's single bounded source page, including on fallback.
    grouped = {}
    for row in rows:
        pair = bucket_bounds(instant(row.start), frame, calendar)
        grouped.setdefault((ms(pair[0]), ms(pair[1])), []).append(row)
    remaining, changed = set(touched), set()
    for target in targets:
        members = grouped.get((target.start, target.end), [])
        if not members or any(not row.complete or row.end-row.start != 60000 for row in members):
            continue
        if (target.open, target.high, target.low, target.close, target.volume,
                target.volume_complete) != (
                members[0].open, max(row.high for row in members), min(row.low for row in members),
                members[-1].close, total(members), all(row.volume_complete for row in members)):
            continue
        observed = max(row.observed_at for row in members)
        if observed > target.observed_at:
            target.observed_at = observed
            changed.add(target.start)
        remaining.difference_update(buckets[(target.start, target.end)])
    if changed:
        from .publication_jobs import enqueue_publication
        from .publication_schedule import request, source_frames
        enqueue_publication(db, instrument.id, frame, changed)
        request(db, instrument.id, frames=source_frames(frame))
    return remaining
