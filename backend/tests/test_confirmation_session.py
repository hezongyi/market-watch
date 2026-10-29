"""Real fenced confirmation transactions; no upstream or notification delivery."""
import os
import uuid
from datetime import UTC, datetime

import pytest
from alerts import live_pricing as live
from alerts import storage
from alerts.config import settings
from alerts.live_confirmation import health
from alerts.market_contracts import CandleBatch, RequestResult
from alerts.storage import Instrument, LiveMinute, LiveState, MarketDataset, SourceMinute
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from test_live_pricing import candles, quote
from test_live_session import generator
from test_market_contracts import minute

STAMP = int(datetime(2026, 10, 24, 6, tzinfo=UTC).timestamp() * 1000)


@pytest.fixture
def confirmation_database(database, monkeypatch):
    url = os.environ.get('MW_CONFIRMATION_TEST_DATABASE_URL')
    if not url:
        yield database
        return
    # A unique schema in the explicitly supplied task-only test database.
    schema = 'confirmation_' + uuid.uuid4().hex
    admin = create_engine(url)
    with admin.begin() as connection:
        connection.execute(text('CREATE SCHEMA ' + schema))
    engine = create_engine(url, connect_args={'options': '-csearch_path=' + schema})
    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, 'Session', factory)
    try:
        yield factory
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text('DROP SCHEMA ' + schema + ' CASCADE'))
        admin.dispose()


@pytest.fixture
def weekend(confirmation_database, monkeypatch):
    monkeypatch.setattr(settings, 'oanda_resident_symbols', 'EUR_USD')
    monkeypatch.setattr(settings, 'oanda_calendar_profiles', {})
    monkeypatch.setattr(settings, 'oanda_live_session_profiles', {})
    monkeypatch.setattr(settings, 'oanda_recovery_minutes', 2)
    live.ensure_catalog([{'name': 'EUR_USD', 'type': 'CURRENCY', 'displayPrecision': 5}],
                        'test-account')
    from alerts.realtime_switch import set_enabled
    with confirmation_database.begin() as db:
        dataset = next(row for row in db.scalars(select(MarketDataset))
                       if row.identity.get('provider_symbol') == 'EUR_USD')
        set_enabled(db, dataset.instrument_id, True, now=STAMP)
    identity = live.desired_datasets('test-account')['EUR_USD']
    owner = live.claim('test-account', now=STAMP)
    epoch = live.begin_connection(owner, {'EUR_USD': identity}, now=STAMP)
    return confirmation_database, owner, epoch, identity


@pytest.fixture
def running(confirmation_database, monkeypatch):
    monkeypatch.setattr(settings, 'oanda_resident_symbols', 'EUR_USD')
    monkeypatch.setattr(settings, 'oanda_recovery_minutes', 2)
    monkeypatch.setattr('alerts.live_pricing.now_ms', lambda: 125000)
    monkeypatch.setattr('alerts.live_window.now_ms', lambda: 125000)
    live.ensure_catalog([{'name': 'EUR_USD', 'type': 'CURRENCY', 'displayPrecision': 5}], 'test-account')
    from alerts.realtime_switch import set_enabled
    with confirmation_database.begin() as db:
        dataset = next(row for row in db.scalars(select(MarketDataset))
                       if row.identity.get('provider_symbol') == 'EUR_USD')
        set_enabled(db, dataset.instrument_id, True, now=125000)
    identities = live.desired_datasets('test-account')
    owner = live.claim('test-account', now=125000)
    epoch = live.begin_connection(owner, identities, now=125000)
    return confirmation_database, owner, epoch, identities


def empty(identity, **changes):
    return CandleBatch(**dict(identity=identity, window_start=STAMP-180000,
        window_end=STAMP-60000, observed_at=STAMP, rows=(),
        result=RequestResult(status='empty_success'), volume_kind='price_count',
        volume_unit='quotes') | changes)


def profile(identity):
    return generator()(identity.account_scope, datetime(2026, 10, 24, tzinfo=UTC),
        datetime(2026, 10, 31, tzinfo=UTC), ['EUR_USD'])['EUR_USD']


@pytest.mark.parametrize('configuration', ['missing', 'expired', 'wrong_scope'])
def test_unknown_empty_is_waiting_without_lateness_or_fabricated_readiness(weekend, monkeypatch, configuration):
    factory, owner, epoch, identity = weekend
    value = profile(identity)
    if configuration == 'expired':
        value['source_session']['reviewed_end'] = '2026-10-24T00:01:00+00:00'
    elif configuration == 'wrong_scope':
        value['source_session']['account_scope'] = 'sha256:' + '0'*64
    monkeypatch.setattr(settings, 'oanda_live_session_profiles',
                        {} if configuration == 'missing' else {'EUR_USD': value})
    live.commit_confirmation(owner, epoch, empty(identity), now=STAMP)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        metric = db.scalar(select(LiveMinute).where(LiveMinute.start == STAMP-120000))
        assert metric.expected is None and metric.last_result == 'empty_success'
        assert not health(db, state).get('error')
        assert not state.ready and state.confirmed_end == 0
        assert STAMP < state.next_confirm_at <= STAMP+90000
        assert db.scalar(select(SourceMinute)) is None


def test_runtime_profile_reclassifies_existing_unknown_minute_without_changing_history(weekend, monkeypatch):
    factory, owner, epoch, identity = weekend
    live.commit_confirmation(owner, epoch, empty(identity), now=STAMP)
    monkeypatch.setattr(settings, 'oanda_live_session_profiles', {'EUR_USD': profile(identity)})
    live.commit_confirmation(owner, epoch, empty(identity), now=STAMP+1000)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        metric = db.scalar(select(LiveMinute).where(LiveMinute.start == STAMP-120000))
        assert metric.expected is False and metric.expectation == 'reviewed_source_closure'
        assert state.confirmed_end == 0
        dataset = db.get(MarketDataset, identity.key)
        assert dataset.identity == identity.model_dump(mode='json')
        assert db.get(Instrument, dataset.instrument_id).calendar_profile == {}


def test_observed_missing_minute_remains_faulted_until_real_backfill_even_with_sparse_later_rows(running):
    factory, owner, epoch, identities = running
    identity = identities['EUR_USD']
    live.publish_event(owner, epoch, quote(identity, epoch, source=65000), identities, now=125000)
    # Minute 0 has no evidence of data. Minute 60s really was observed.
    live.commit_confirmation(owner, epoch, candles(identity, rows=(),
        result=RequestResult(status='empty_success')), now=151000)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert health(db, state)['error'] == 'm1_late'
        assert health(db, state)['evidence']['expected'] is True
    assert live.renew(owner, now=151000)
    live.commit_confirmation(owner, epoch, candles(identity, window_end=180000,
        checkpoint=180000, rows=(minute(120000, volume="4"),)), now=175000)
    with factory.begin() as db:
        assert health(db, db.get(LiveState, identity.key))['open']
    live.commit_confirmation(owner, epoch, candles(identity, window_end=180000,
        checkpoint=180000, rows=(minute(60000, volume="4"), minute(120000, volume="4"))), now=176000)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert not health(db, state)['open'] and state.ready
        assert db.scalar(select(LiveMinute).where(LiveMinute.start == 0)).confirmed_at is None


def test_real_transport_fault_is_not_recovered_by_unknown_empty(weekend):
    factory, owner, epoch, identity = weekend
    live.commit_confirmation(owner, epoch, empty(identity,
        result=RequestResult(status='timeout', phase='tls')), now=STAMP)
    live.commit_confirmation(owner, epoch, empty(identity), now=STAMP+1000)
    with factory.begin() as db:
        assert health(db, db.get(LiveState, identity.key))['error'] == 'timeout'


def test_backfilling_old_incident_does_not_hide_new_observed_gap(running):
    factory, owner, epoch, identities = running
    identity = identities['EUR_USD']
    live.publish_event(owner, epoch, quote(identity, epoch, source=65000), identities, now=125000)
    live.commit_confirmation(owner, epoch, candles(identity, rows=(),
        result=RequestResult(status='empty_success')), now=151000)
    assert live.renew(owner, now=151000)
    live.publish_event(owner, epoch, quote(identity, epoch, seq=2, source=125000), identities, now=175000)
    for at in (175000, 200000, 225000, 250000):
        assert live.renew(owner, now=at)
    live.commit_confirmation(owner, epoch, candles(identity, window_end=240000, checkpoint=240000,
        rows=(minute(60000, volume='4'), minute(180000, volume='4'))), now=251000)
    with factory.begin() as db:
        incident = health(db, db.get(LiveState, identity.key))
        assert incident['open'] and incident['error'] == 'm1_late'
        assert incident['window_end'] >= 180000


def test_pending_rest_observation_requires_real_confirmation_even_when_later_tail_exists(running):
    from alerts.oanda_rest_batch import CandleSpec, live_demand_revision, normalize_latest

    factory, owner, epoch, identities = running
    identity = identities['EUR_USD']
    spec = CandleSpec.from_dataset(identity)
    sample = normalize_latest({'latestCandles': [{'instrument': 'EUR_USD', 'granularity': 'M1',
        'candles': [{'time': '120', 'complete': False, 'volume': 3,
            'bid': {'o': '1.10', 'h': '1.12', 'l': '1.09', 'c': '1.11'}}]}]},
        [spec], generation=epoch, sequence=1, demand_revision=live_demand_revision([spec]),
        requested_at=124900, received_at=125000)
    live.publish_rest_batch(owner, epoch, sample, identities, now=125000)
    for at in (150000,175000,200000,225000,250000):
        assert live.renew(owner, now=at)
    live.commit_confirmation(owner, epoch, candles(identity, window_end=240000, checkpoint=240000,
        observed_at=251000, rows=(minute(180000, volume='4'),)), now=251000)
    with factory.begin() as db:
        metric = db.scalar(select(LiveMinute).where(LiveMinute.start == 120000))
        assert metric.expected is True and metric.confirmed_at is None
        assert health(db, db.get(LiveState, identity.key))['error'] == 'm1_late'


def test_optional_evidence_keeps_old_confirmation_json_and_source_state_compatible(weekend):
    from alerts.storage import Preference

    factory, owner, epoch, identity = weekend
    with factory.begin() as db:
        db.merge(Preference(key='live_confirmation:v1:' + identity.key, value={
            'epoch': epoch, 'open': True, 'error': 'timeout',
            'window_start': STAMP-180000, 'window_end': STAMP-60000}))
    live.commit_confirmation(owner, epoch, empty(identity), now=STAMP)
    first = live.snapshots(now=STAMP)
    second = live.snapshots(now=STAMP)
    assert first == second
    state = next(row for row in first if row['dataset_id'] == identity.key)
    assert state['confirmation_error'] == 'timeout'
    assert state['session_configuration']['profile_reason'] == 'missing_profile'
    assert identity.account_scope not in str(state['session_configuration'])


def test_worker_and_real_adapter_bound_unknown_probes_and_skip_verified_closure(weekend, monkeypatch):
    import httpx
    from alerts import oanda_worker
    from alerts.oanda_rest_batch import OandaRestBatch

    factory, owner, epoch, identity = weekend
    monkeypatch.setattr(live, 'now_ms', lambda: STAMP)
    monkeypatch.setattr(oanda_worker, 'now_ms', lambda: STAMP)
    calls = []

    def upstream(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={'instrument': 'EUR_USD', 'granularity': 'M1', 'candles': []})

    with httpx.Client(transport=httpx.MockTransport(upstream)) as client:
        adapter = OandaRestBatch(token='synthetic-only', account_id='test-account',
                                 rest_client=client, clock=lambda: STAMP)
        for _ in range(4):
            assert oanda_worker.confirm_pages(adapter, owner, epoch, {'EUR_USD': identity}, lambda: False) is None
        assert len(calls) == 1
        assert oanda_worker.closed_delay({'EUR_USD': identity}) is None
        with factory.begin() as db:
            assert not health(db, db.get(LiveState, identity.key)).get('error')
        monkeypatch.setattr(settings, 'oanda_live_session_profiles', {'EUR_USD': profile(identity)})
        assert oanda_worker.closed_delay({'EUR_USD': identity}) > 0
        epoch = live.begin_connection(owner, {'EUR_USD': identity}, now=STAMP)
        oanda_worker.confirm_pages(adapter, owner, epoch, {'EUR_USD': identity}, lambda: False)
        assert len(calls) == 1
