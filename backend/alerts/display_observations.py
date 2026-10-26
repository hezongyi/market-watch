"""Persistent, source-isolated display input. Freshness admits; it never erases.

Confirmed composite inputs always win. A reconnect selects the newest epoch
fragment without inventing the unobserved part of its candle.
"""

from decimal import Decimal

from sqlalchemy import delete, exists, func, select, text

from .storage import Audit, CompositeMinuteInput, ObservedMinute, Preference

# An explicit hard bound; when exhausted, freeze new display minutes rather than
# silently evicting the oldest accepted candle. Quotes/alerts keep their own gate.
MAX_MINUTES = 4096
MAX_GLOBAL_MINUTES = 32768


def _has_capacity(db, dataset_id, stamp):
    if db.bind.dialect.name == 'postgresql':
        db.execute(text('SELECT pg_advisory_xact_lock(8675311)'))
    size = db.scalar(select(func.count()).select_from(ObservedMinute).where(
        ObservedMinute.dataset_id == dataset_id))
    total = db.scalar(select(func.count()).select_from(ObservedMinute))
    status_key = 'display_capacity:' + dataset_id
    exhausted = db.get(Preference, status_key)
    if size >= MAX_MINUTES or total >= MAX_GLOBAL_MINUTES:
        if not exhausted:
            db.add(Audit(kind='display_capacity_exhausted', details={
                'dataset': dataset_id, 'limit': MAX_MINUTES, 'effective_at': stamp}))
            db.add(Preference(key=status_key, value={'at': stamp, 'reason': 'capacity_exhausted'}))
        return False
    if exhausted:
        db.delete(exhausted)
    return True


def accept(db, state, event, *, stamp, profile):
    from .live_session import session_status

    if (not event.tradeable or event.bid is None or event.ask is None
            or Decimal(event.ask) < Decimal(event.bid)
            or not 0 <= stamp - event.source_time <= 15000
            or not 0 <= stamp - event.received_at <= 15000
            or session_status(event.identity.model_dump(), profile, stamp)['market_session'] == 'closed'):
        return
    start = event.source_time // 60000 * 60000
    key = (state.dataset_id, start, state.epoch)
    observation = db.get(ObservedMinute, key)
    if not observation:
        if not _has_capacity(db, state.dataset_id, stamp):
            return
        observation = ObservedMinute(dataset_id=state.dataset_id, start=start, epoch=state.epoch,
            content={'start': start, 'end': start + 60000, 'open': event.bid,
                'high': event.bid, 'low': event.bid, 'close': event.bid,
                'complete': False, 'volume': None, 'volume_kind': 'unavailable',
                'observation_complete': False, 'connection_epoch': state.epoch, 'source': 'oanda'})
        db.add(observation)
    else:
        old = observation.content
        observation.content = {**old, 'high': str(max(Decimal(old['high']), Decimal(event.bid))),
            'low': str(min(Decimal(old['low']), Decimal(event.bid))), 'close': event.bid}
    observation.observed_at, observation.sequence = event.received_at, event.sequence
    return observation


def accept_rest(db, state, sample, *, stamp, profile):
    """Replace supplier OHLCV atomically under the caller's fenced owner lock.

    Unlike stream samples, a supplier revision may shrink high/low or volume.
    Display credentials copy this content, so later replacement cannot mutate
    the meaning of an already returned snapshot token.
    """
    from .live_session import session_status
    from .oanda_rest_batch import CandleSpec, CloseObservation
    from .source_registry import collection_identity
    from .storage import LiveState, MarketDataset, SourceMinute

    sample = CloseObservation.model_validate(sample)
    state = db.scalar(select(LiveState).where(LiveState.dataset_id == state.dataset_id)
        .with_for_update().execution_options(populate_existing=True))
    dataset = db.get(MarketDataset, state.dataset_id)
    if CandleSpec.from_dataset(dataset.identity) != sample.spec:
        raise ValueError('REST display source identity mismatch')
    if (state.epoch != sample.generation or sample.committed_at != stamp
            or not 0 <= stamp - sample.received_at <= 15000
            or session_status(dataset.identity, profile, stamp)['market_session'] == 'closed'):
        return
    source = collection_identity(dataset.identity)
    if db.get(SourceMinute, (source.key, sample.candle.start)):
        return  # Confirmed heads cannot be downgraded to provisional.
    key = (state.dataset_id, sample.candle.start, state.epoch)
    observation = db.get(ObservedMinute, key)
    if observation and (observation.sequence >= sample.sequence
                        or observation.observed_at >= sample.received_at):
        return
    if state.forming and (state.forming['start'] > sample.candle.start or
            state.forming.get('acquisition_mode') == 'rest_batch'
            and state.forming.get('connection_epoch') == sample.generation
            and state.forming.get('sequence', 0) >= sample.sequence):
        return
    if not observation:
        if not _has_capacity(db, state.dataset_id, stamp):
            return
        observation = ObservedMinute(dataset_id=state.dataset_id, start=sample.candle.start,
            epoch=state.epoch)
        db.add(observation)
    observation.content = {**sample.candle.model_dump(), 'volume_kind': 'price_count',
        'volume_unit': 'quotes', 'volume_complete': False, 'observation_complete': False,
        'connection_epoch': sample.generation, 'sequence': sample.sequence, 'source': 'oanda',
        'source_identity': sample.spec.identity.model_dump(), 'acquisition_mode': 'rest_batch',
        'protocol_version': sample.protocol_version, 'observation': sample.model_dump(mode='json'),
        'snapshot_id': sample.snapshot_id}
    observation.observed_at, observation.sequence = sample.received_at, sample.sequence
    state.forming = dict(observation.content)
    return observation


def handover_legacy(db, state):
    """One-time adoption of a verifiable last quote, never raw forming OHLC.

    Old forming rows mixed valid and ineligible quotes without provenance. Only
    the persisted last QuoteEvent can pass the current admission gate. Evaluate
    freshness at its recorded receive time; present age cannot erase evidence.
    """
    from .market_contracts import QuoteEvent
    from .storage import Instrument, MarketDataset

    key = 'display_handover:' + state.dataset_id
    if db.get(Preference, key) or not state.quote:
        return
    # Same source lock as quote/confirmation writers; after waiting, refresh so
    # an older session identity-map value cannot reconstruct a superseded quote.
    from .storage import LiveState

    state = db.scalar(select(LiveState).where(LiveState.dataset_id == state.dataset_id)
        .with_for_update().execution_options(populate_existing=True))
    if db.get(Preference, key):
        return
    accepted = False
    try:
        event = QuoteEvent.model_validate(state.quote)
        dataset = db.get(MarketDataset, state.dataset_id)
        if event.identity.key == state.dataset_id and event.connection_epoch == state.epoch:
            inst = db.get(Instrument, dataset.instrument_id)
            start = event.source_time // 60000 * 60000
            existing = db.get(ObservedMinute, (state.dataset_id, start, state.epoch))
            if not existing:
                accepted = bool(accept(db, state, event, stamp=event.received_at, profile=inst.calendar_profile))
    except (ValueError, TypeError, KeyError):
        pass
    db.add(Preference(key=key, value={'adopted_last_quote': accepted}))
    if accepted:
        db.add(Audit(kind='display_legacy_quote_adopted', details={
            'dataset': state.dataset_id, 'minute': start,
            'reason': 'only_last_quote_verifiable;legacy_forming_ohlc_excluded'}))


def pending_query(dataset_id, revision_id, input_revision):
    return select(ObservedMinute).where(ObservedMinute.dataset_id == dataset_id,
        ~exists(select(CompositeMinuteInput.start).where(
            CompositeMinuteInput.revision_id == revision_id,
            CompositeMinuteInput.start == ObservedMinute.start,
            CompositeMinuteInput.input_revision <= input_revision)))


def read(db, dataset_id, revision_id, input_revision, start, end, *, now=None):
    selected = {}
    query = pending_query(dataset_id, revision_id, input_revision).where(
        ObservedMinute.start >= start, ObservedMinute.start < end).order_by(
            ObservedMinute.start, ObservedMinute.epoch)
    if now is not None:
        query = query.where(ObservedMinute.observed_at <= now)
    for observation in db.scalars(query):
        selected[observation.start] = {**observation.content,
            'provisional_input': {'epoch': observation.epoch, 'sequence': observation.sequence,
                'observed_at': observation.observed_at, 'minute': dict(observation.content)}}
    return list(selected.values())


def latest(db, dataset_id, revision_id, input_revision, start, end):
    query = pending_query(dataset_id, revision_id, input_revision).where(
        ObservedMinute.start >= start, ObservedMinute.start < end)
    return db.scalar(query.with_only_columns(func.max(ObservedMinute.start)))


def retire_confirmed(db, source_id, starts):
    """Reclaim only after every matching composite can read the confirmation.

    Display snapshots must copy their overlay content before returning a token;
    they may not reference these mutable rows after this transaction commits.
    """
    from .storage import (
        CompositeMinute,
        CompositeRevision,
        DatasetSource,
        MarketDataset,
        RealtimeMapping,
    )

    datasets = select(MarketDataset).join(
        DatasetSource, DatasetSource.dataset_id == MarketDataset.id
    ).where(DatasetSource.source_id == source_id)
    for dataset in db.scalars(datasets):
        revisions = list(db.scalars(select(CompositeRevision).join(RealtimeMapping,
            CompositeRevision.mapping_id == RealtimeMapping.id).where(
                RealtimeMapping.target_dataset_id == dataset.id)))
        heads = set(db.execute(select(CompositeMinute.revision_id, CompositeMinute.start).where(
            CompositeMinute.revision_id.in_([revision.id for revision in revisions]),
            CompositeMinute.start.in_(starts))).all()) if revisions else set()
        safe = [at for at in starts if all(at < revision.seam or (revision.id, at) in heads
                                         for revision in revisions)]
        if safe:
            db.execute(delete(ObservedMinute).where(ObservedMinute.dataset_id == dataset.id,
                ObservedMinute.start.in_(safe)))
