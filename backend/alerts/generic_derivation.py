"""Demand-bound compatibility aggregates; source/composite inputs never pause.

Keep dirty ranges durable while a compatibility series has no independent
consumer. Readers commit an expiring demand before checking readiness.
"""
import hashlib

from sqlalchemy import or_, select

from .storage import (
    ChartAggregationJob,
    ChartAlert,
    ChartAlertVersion,
    ChartHistoryPlan,
    ChartPublicationState,
    ChartViewportDemand,
    HistoryArtifact,
    HistoryReclamation,
    HistoryVersion,
    ImportJob,
    MarketDataset,
    MarketDemand,
    Preference,
    RealtimeMapping,
    VolumeBackfillJob,
    now_ms,
    transaction,
)


def candidates():
    return select(MarketDataset.instrument_id).join(Preference,
        Preference.key == 'managed_realtime:' + MarketDataset.instrument_id).where(
        Preference.value['enabled'].as_boolean().is_(False),
        select(RealtimeMapping.id).where(
            RealtimeMapping.target_dataset_id == MarketDataset.id).exists())


def historical_candidates():
    """Fixed history is available and the separate chart plan is inactive."""
    return select(ChartHistoryPlan.instrument_id).join(
        MarketDataset, MarketDataset.instrument_id == ChartHistoryPlan.instrument_id
    ).where(ChartHistoryPlan.status == 'cancelled',
        select(HistoryVersion.id).join(HistoryArtifact, HistoryArtifact.version_id == HistoryVersion.id).where(
            HistoryVersion.dataset_id == MarketDataset.id, HistoryVersion.status == 'published',
            HistoryArtifact.status == 'published', HistoryArtifact.timeframe != 'M1', HistoryArtifact.count > 0,
            ~select(HistoryReclamation.version_id).where(
                HistoryReclamation.version_id == HistoryVersion.id).exists(),
        ).exists())


def independent_consumers(stamp):
    rules = select(ChartAlertVersion.config['instrument'].as_string()).join(ChartAlert,
        (ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlertVersion.config['instrument'].as_string().is_not(None),
        ChartAlertVersion.config['series_kind'].as_string() == 'managed',
        or_(ChartAlert.status.in_(('active', 'paused')) &
            (ChartAlert.expires_at.is_(None) | (ChartAlert.expires_at > stamp)),
            ChartAlert.runtime['settlement_pending'].as_boolean().is_(True)))
    return select(MarketDemand.instrument_id).where(MarketDemand.expires > stamp).union(
        select(ChartViewportDemand.instrument_id).where(ChartViewportDemand.expires > stamp), rules,
        select(ChartHistoryPlan.instrument_id).where(ChartHistoryPlan.status == 'pending'),
        select(ImportJob.instrument_id).where(ImportJob.status.in_(('pending', 'running'))),
        select(VolumeBackfillJob.instrument_id).where(VolumeBackfillJob.status.in_(('pending', 'running'))))


def paused_query(stamp):
    return candidates().where(MarketDataset.instrument_id.not_in(independent_consumers(stamp)))


def runnable_aggregation(stamp):
    from .chart_aggregation import MAX_RANGE

    idle_history = historical_candidates().where(
        ChartHistoryPlan.instrument_id.not_in(independent_consumers(stamp)))
    job = ChartAggregationJob
    return job.instrument_id.not_in(paused_query(stamp)) & or_(
        job.kind != 'price', job.end > stamp - MAX_RANGE, job.instrument_id.not_in(idle_history))


def paused_instruments(db, *, now=None):
    return tuple(db.scalars(paused_query(now_ms() if now is None else now)))


def is_paused(db, instrument):
    return db.scalar(paused_query(now_ms()).where(
        MarketDataset.instrument_id == instrument).limit(1)) is not None


def is_candidate(db, instrument):
    return db.scalar(candidates().where(MarketDataset.instrument_id == instrument).union_all(
        historical_candidates().where(ChartHistoryPlan.instrument_id == instrument)).limit(1)) is not None


def touch(db, instrument, *, now=None):
    if not is_candidate(db, instrument):
        return False
    stamp = now_ms() if now is None else now
    ident = 'derive:' + hashlib.sha256(instrument.encode()).hexdigest()[:32]
    from .publication_wakeup import notify_derivation
    from .source_history_store import _insert

    # One row per instrument, not per HTTP request. A concurrent reader cannot
    # shorten another reader's lease. This lease never enables source collection.
    result = db.execute(_insert(db)(MarketDemand).values(id=ident, instrument_id=instrument,
        expires=stamp + 45000, updated_at=stamp).on_conflict_do_update(
            index_elements=['id'], set_={'expires': stamp + 45000, 'updated_at': stamp},
            where=MarketDemand.expires < stamp + 30000))
    if result.rowcount:
        notify_derivation(db)
    return True


def pending(db, instrument, frame, *, published=False):
    source = 'M15' if frame == 'M30' else 'D1' if frame in ('W1', 'MN') else frame
    if source != 'M1' and db.scalar(select(ChartAggregationJob.id).where(
            ChartAggregationJob.instrument_id == instrument,
            ChartAggregationJob.timeframe == source).limit(1)):
        return True
    return bool(published and db.scalar(select(ChartPublicationState.instrument_id).where(
        ChartPublicationState.instrument_id == instrument,
        ChartPublicationState.timeframe == frame,
        ChartPublicationState.requested > ChartPublicationState.processed).limit(1)))


def check_read(db, instrument, frame, *, published=False):
    if is_candidate(db, instrument) and pending(db, instrument, frame, published=published):
        from .query_errors import QueryError
        raise QueryError(503, {'code': 'DERIVATION_PENDING', 'message': '独立行情正在补齐，请稍后重试'})


def prepare_read(instrument, frame, *, published=False):
    with transaction() as db:
        deferred = touch(db, instrument) and pending(db, instrument, frame, published=published)
    if deferred:
        from .query_errors import QueryError
        raise QueryError(503, {'code': 'DERIVATION_PENDING', 'message': '独立行情正在补齐，请稍后重试'})
