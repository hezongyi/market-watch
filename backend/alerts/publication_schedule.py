"""Durable input generations and fair bounded selection for legacy publications.

Writers already own the Instrument lock. Workers acquire that same lock before
the state row, keeping the existing ingestion/aggregation lock order. Wakeups
live in the same transaction as input writes; no process memory acknowledges work.
"""

import time
from weakref import WeakKeyDictionary

from sqlalchemy import case, func, select, update

from .chart_data import FRAMES
from .publication_result import PublicationResult
from .source_history_store import _insert
from .storage import (
    PUBLICATION_SERVICE_SEQUENCE,
    ChartAggregationJob,
    ChartHistoryPlan,
    ChartPublication,
    ChartPublicationJob,
    ChartPublicationState,
    Instrument,
    transaction,
)

INITIAL = 1
BARS = 2
COVERAGE = 4
AGGREGATED = 8
RULES = 16
_DISCOVER_AT = WeakKeyDictionary()


def _service(db, state, stamp):
    # PostgreSQL sequences never hold a global row lock across publication and
    # may leave harmless gaps on rollback. SQLite serializes writers itself.
    state.last_service_seq = (db.scalar(PUBLICATION_SERVICE_SEQUENCE.next_value())
        if db.get_bind().dialect.name == 'postgresql' else
        (db.scalar(select(func.max(ChartPublicationState.last_service_seq))) or 0) + 1)
    state.served_at = stamp


def _queue(db, stamp, **facts):
    earliest = db.scalar(select(func.min(ChartPublicationState.next_at)).where(
        ChartPublicationState.requested > ChartPublicationState.processed))
    return PublicationResult(**facts, runnable_remaining=earliest is not None and earliest <= stamp,
                             next_due_at=earliest)


def request(db, instrument_id, *, frames=FRAMES, reason=BARS, stamp=None, approved=False):
    """Coalesce one input transaction, keeping every newer request generation."""
    if not frames:
        return
    if not approved and not db.scalar(select(ChartHistoryPlan.instrument_id).where(
            ChartHistoryPlan.instrument_id == instrument_id)) and not db.scalar(
            select(ChartPublication.instrument_id).where(ChartPublication.instrument_id == instrument_id).limit(1)):
        return
    from .storage import now_ms
    ready_at = now_ms()
    rows = [dict(instrument_id=instrument_id, timeframe=frame, requested=1, processed=0,
                 reasons=reason, requested_at=ready_at, served_at=0, next_at=ready_at, attempts=0)
            for frame in set(frames)]
    model = ChartPublicationState
    statement = _insert(db)(model).values(rows)
    db.execute(statement.on_conflict_do_update(index_elements=['instrument_id', 'timeframe'], set_={
        'requested': model.requested + 1,
        'reasons': model.reasons.op('|')(reason),
        'requested_at': case((model.requested == model.processed, ready_at), else_=model.requested_at),
        # Fresh input must not repeatedly cancel a deterministic failure's
        # retry delay. New generation remains pending and is served when due.
        'next_at': case((model.attempts > 0, model.next_at), else_=ready_at),
        'attempts': model.attempts,
        'blocked_reason': case((model.attempts > 0, model.blocked_reason), else_=None),
    }))


def source_frames(source):
    return (source, 'M30') if source == 'M15' else (source, 'W1', 'MN') if source == 'D1' else (source,)


def discover(db, stamp):
    """Low-frequency bounded adoption, independent of the high-frequency ready check."""
    engine = db.get_bind()
    if time.monotonic() < _DISCOVER_AT.get(engine, 0):
        return
    from .managed_dataset import adopt_legacy_once

    # Set before scanning so exceptions do not immediately hammer legacy history.
    _DISCOVER_AT[engine] = time.monotonic() + 60
    adopt_legacy_once(limit=20)
    targets = select(ChartHistoryPlan.instrument_id).union(select(ChartPublication.instrument_id)).subquery()
    # A migration seeds existing records. This catches post-upgrade plans created
    # by older applications without turning every target into periodic busy work.
    missing = list(db.scalars(select(targets.c.instrument_id).where(
        select(func.count()).select_from(ChartPublicationState).where(
            ChartPublicationState.instrument_id == targets.c.instrument_id,
            ChartPublicationState.timeframe.in_(FRAMES)).scalar_subquery() < len(FRAMES)).limit(20)))
    for ident in missing:
        if db.scalar(select(Instrument).where(Instrument.id == ident).with_for_update(skip_locked=True)) is None:
            continue
        request(db, ident, reason=INITIAL, stamp=stamp, approved=True)
    # Older applications/manual repair tools can persist bucket jobs without a
    # request generation. Recover only ready dirty buckets, never wake every
    # unchanged snapshot or an aggregate still waiting for its source.
    missed = list(db.execute(select(ChartPublicationJob.instrument_id,
        ChartPublicationJob.timeframe).join(ChartPublicationState,
            (ChartPublicationState.instrument_id == ChartPublicationJob.instrument_id) &
            (ChartPublicationState.timeframe == ChartPublicationJob.timeframe)).where(
        ChartPublicationState.requested == ChartPublicationState.processed,
        ~select(ChartAggregationJob.id).where(
            ChartAggregationJob.instrument_id == ChartPublicationJob.instrument_id,
            ChartAggregationJob.timeframe == case(
                (ChartPublicationJob.timeframe == 'M30', 'M15'),
                (ChartPublicationJob.timeframe.in_(('W1', 'MN')), 'D1'),
                else_=ChartPublicationJob.timeframe),
            ChartAggregationJob.start < ChartPublicationJob.end,
            ChartAggregationJob.end > ChartPublicationJob.start).exists()).distinct().limit(20)))
    for ident, frame in missed:
        if db.scalar(select(Instrument).where(Instrument.id == ident).with_for_update(skip_locked=True)) is None:
            continue
        request(db, ident, frames=(frame,), reason=BARS, stamp=stamp, approved=True)


def tick(publisher, corrections):
    from . import managed_dataset

    with transaction() as db:
        stamp = managed_dataset.now_ms()
        discover(db, stamp)
        selected = db.execute(select(ChartPublicationState, Instrument).join(
            Instrument, Instrument.id == ChartPublicationState.instrument_id).where(
            ChartPublicationState.requested > ChartPublicationState.processed,
            ChartPublicationState.next_at <= stamp).order_by(
                ChartPublicationState.last_service_seq, ChartPublicationState.requested_at,
                ChartPublicationState.instrument_id, ChartPublicationState.timeframe).limit(1)
            .with_for_update(of=Instrument, skip_locked=True)).first()
        if selected is None:
            earliest = db.scalar(select(func.min(ChartPublicationState.next_at)).where(
                ChartPublicationState.requested > ChartPublicationState.processed))
            return PublicationResult(next_due_at=max(stamp + 100, earliest) if earliest is not None else None,
                                     blocked_reason='locked' if earliest is not None and earliest <= stamp else None)
        state, inst = selected
        ident, frame = state.instrument_id, state.timeframe
        managed_dataset._PUBLISH_CURSOR = (ident, frame)
        state = db.scalar(select(ChartPublicationState).where(
            ChartPublicationState.instrument_id == ident, ChartPublicationState.timeframe == frame)
            .with_for_update().execution_options(populate_existing=True))
        if state.requested <= state.processed or state.next_at is None or state.next_at > stamp:
            return PublicationResult()
        generation = state.requested
        try:
            with db.begin_nested():
                from .coverage_projection import backfill_page
                coverage_work = backfill_page(db, inst, limit=64)
                from .publication_budget import current
                if current() and coverage_work['examined']:
                    current().consume(coverage_work['examined'])
                plan = db.get(ChartHistoryPlan, ident)
                pub = db.get(ChartPublication, (ident, frame))
                result = publisher(db, inst, plan, frame, stamp) if plan else (
                    corrections(db, inst, pub, frame, pub.start, pub.end, [], stamp) if pub else PublicationResult())
                result = result if result is not None else PublicationResult()
                db.flush()
        except Exception as error:
            state.attempts += 1
            state.next_at = stamp + min(300_000, 1000 * 2 ** min(state.attempts, 8))
            _service(db, state, stamp)
            state.blocked_reason = type(error).__name__[:40]
            return _queue(db, stamp, selected_target=(ident, frame), attempted=True,
                          blocked_reason=state.blocked_reason)
        # The equality condition also protects callers that enqueue another
        # generation inside the same publication transaction.
        _service(db, state, stamp)
        state.attempts = 0
        if result.runnable_remaining or (not coverage_work['complete'] and
                                        not coverage_work.get('maintenance_required')):
            state.next_at = stamp
            state.blocked_reason = None
        elif result.next_due_at is not None and result.blocked_reason == 'source':
            state.next_at = max(stamp + 1000, result.next_due_at)
            state.blocked_reason = result.blocked_reason
        else:
            db.execute(update(ChartPublicationState).where(
                ChartPublicationState.instrument_id == ident, ChartPublicationState.timeframe == frame,
                ChartPublicationState.requested == generation).values(
                    processed=generation, reasons=0, next_at=None, blocked_reason=result.blocked_reason))
        return _queue(db, stamp, snapshot_changed=result.snapshot_changed, task_progressed=True,
                      selected_target=(ident, frame), attempted=True, blocked_reason=result.blocked_reason)
