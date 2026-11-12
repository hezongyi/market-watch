"""Exercise full quote transactions, including their persistent display state."""

from collections import Counter

import pytest
from alerts import live_pricing as live
from alerts.storage import Instrument, LiveMinute, LiveState, MarketDataset, ObservedMinute
from sqlalchemy import event, select
from test_live_pricing import quote
from test_live_pricing import running as running


def test_steady_quote_reads_once_and_flushes_complete_snapshot(running):
    factory, owner, epoch, identities = running
    identity = identities['EUR_USD']
    completed = set()
    for seq in (1, 2):
        live.publish_event(owner, epoch, quote(identity, epoch, seq=seq, source=121000+seq),
                           identities, now=125000, completed_handovers=completed)
    engine, counts = factory.kw['bind'], Counter()

    def sql(conn, cursor, statement, *args):
        counts[statement.split()[0]] += 1

    def flush(db, context):
        counts['flush'] += 1

    def commit(conn):
        counts['commit'] += 1

    event.listen(engine, 'before_cursor_execute', sql)
    event.listen(factory, 'after_flush', flush)
    event.listen(engine, 'commit', commit)
    try:
        assert live.publish_event(owner, epoch,
            quote(identity, epoch, seq=3, source=122000, bid='1.20'), identities,
            now=125000, completed_handovers=completed) == 'accepted'
    finally:
        event.remove(engine, 'before_cursor_execute', sql)
        event.remove(factory, 'after_flush', flush)
        event.remove(engine, 'commit', commit)
    assert counts == Counter(SELECT=4, UPDATE=4, flush=1, commit=1)
    with factory() as db:
        state = db.get(LiveState, identity.key)
        metric = db.scalar(select(LiveMinute).where(LiveMinute.dataset_id == identity.key, LiveMinute.start == 120000))
        display = db.get(ObservedMinute, (identity.key, 120000, epoch))
        instrument = db.get(Instrument, db.get(MarketDataset, identity.key).instrument_id)
        assert state.quote['sequence'] == display.sequence == 3
        assert state.forming == display.content
        assert (display.content['open'], display.content['high'], display.content['close']) == ('1.10', '1.20', '1.20')
        assert metric.quote_count == 3 and metric.expected is True
        assert instrument.last_received == state.received_at == display.observed_at == 123000


@pytest.mark.parametrize('source,bid,ask,tradeable,displayed', [
    (180001, '1.20', '1.40', True, True),
    (122000, '1.20', '1.40', False, False),
    (122000, None, None, True, False),
    (122000, '1.50', '1.40', True, False),
])
def test_preloaded_minutes_preserve_display_admission(running, source, bid, ask, tradeable, displayed):
    factory, owner, epoch, identities = running
    identity, completed = identities['EUR_USD'], set()
    for seq in (1, 2):
        live.publish_event(owner, epoch, quote(identity, epoch, seq=seq, source=121000+seq),
                           identities, now=125000, completed_handovers=completed)
    assert identity.key in completed
    if source >= 180000:
        assert live.renew(owner, now=150000)
        assert live.renew(owner, now=175000)
    assert live.publish_event(owner, epoch,
        quote(identity, epoch, seq=3, source=source, received_at=source, bid=bid,
              ask=ask, tradeable=tradeable), identities, now=source,
        completed_handovers=completed) == 'accepted'
    with factory() as db:
        state = db.get(LiveState, identity.key)
        metric = db.scalar(select(LiveMinute).where(LiveMinute.dataset_id == identity.key, LiveMinute.start == source//60000*60000))
        observation = db.get(ObservedMinute, (identity.key, source//60000*60000, epoch))
        assert state.quote['sequence'] == 3
        assert metric.quote_count == (1 if source >= 180000 else 3)
        assert (observation is not None and observation.sequence == 3) is displayed


def test_cached_quote_failure_rolls_back_all_snapshots(running, monkeypatch):
    from alerts import price_alert_inputs

    factory, owner, epoch, identities = running
    identity, completed = identities['EUR_USD'], set()
    for seq in (1, 2):
        live.publish_event(owner, epoch, quote(identity, epoch, seq=seq, source=121000+seq),
                           identities, now=125000, completed_handovers=completed)
    original = price_alert_inputs.record_quote

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError('after snapshot flush')

    with monkeypatch.context() as patch:
        patch.setattr(price_alert_inputs, 'record_quote', fail)
        with pytest.raises(RuntimeError, match='after snapshot flush'):
            live.publish_event(owner, epoch, quote(identity, epoch, seq=3, source=122000, bid='1.20'),
                               identities, now=125000, completed_handovers=completed)
    with factory() as db:
        state = db.get(LiveState, identity.key)
        observation = db.get(ObservedMinute, (identity.key, 120000, epoch))
        metric = db.scalar(select(LiveMinute).where(LiveMinute.dataset_id == identity.key))
        instrument = db.get(Instrument, db.get(MarketDataset, identity.key).instrument_id)
        assert state.quote['sequence'] == observation.sequence == metric.quote_count == 2
        assert state.forming['close'] == observation.content['close'] == '1.10'
        assert instrument.last_received == state.received_at == observation.observed_at == 122002


def test_cached_quote_capacity_and_new_epoch_keep_separate_fragments(running, monkeypatch):
    from alerts import display_observations

    factory, owner, epoch, identities = running
    identity, completed = identities['EUR_USD'], set()
    for seq in (1, 2):
        live.publish_event(owner, epoch, quote(identity, epoch, seq=seq, source=121000+seq),
                           identities, now=125000, completed_handovers=completed)
    monkeypatch.setattr(display_observations, 'MAX_MINUTES', 1)
    next_epoch = live.begin_connection(owner, identities, now=125000)
    live.publish_event(owner, next_epoch, quote(identity, next_epoch, source=122000, bid='1.20'),
                       identities, now=125000, completed_handovers=completed)
    with factory() as db:
        assert db.get(ObservedMinute, (identity.key, 120000, next_epoch)) is None
        assert db.get(ObservedMinute, (identity.key, 120000, epoch)).sequence == 2
        assert db.get(LiveState, identity.key).quote['connection_epoch'] == next_epoch
    monkeypatch.setattr(display_observations, 'MAX_MINUTES', 2)
    live.publish_event(owner, next_epoch,
        quote(identity, next_epoch, seq=2, source=123000, bid='1.30'),
        identities, now=125000, completed_handovers=completed)
    with factory() as db:
        observation = db.get(ObservedMinute, (identity.key, 120000, next_epoch))
        assert observation.content['open'] == observation.content['close'] == '1.30'
        assert db.get(ObservedMinute, (identity.key, 120000, epoch)).content['close'] == '1.10'
