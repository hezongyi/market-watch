"""Recovery must prove account pricing access, remain quiet, and fence old probes."""
import hashlib
from datetime import datetime

import httpx
import pytest
from alerts import live_pricing as live
from alerts import oanda_worker
from alerts.config import settings
from alerts.market_contracts import (
    DatasetIdentity,
    MarketRequestError,
    RequestResult,
    failed_request,
)
from alerts.oanda_stream import OandaPractice
from alerts.storage import Instrument, LiveState, MarketDataset, PricingOwner, SignalRow
from sqlalchemy import select
from test_live_pricing import candles, quote
from test_live_pricing import running as _running

running = _running


def assert_maintenance_fence(factory, ownership, epoch, identities, monkeypatch):
    from alerts.service import create_watch

    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    first, other = identities['EUR_USD'], identities['XAU_USD']
    for identity in identities.values():
        live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with factory.begin() as db:
        inst = db.get(MarketDataset, first.key).instrument_id
        create_watch(db, inst, 'Maintenance crossing', {'kind': 'price', 'timeframe': 'tick',
            'direction': 'buy', 'level': '1.25'}, armed_at=0, use_history=False)
    live.publish_event(ownership, epoch, quote(first, epoch, source=126000, bid='1.20'),
                       identities, now=126000)
    live.commit_confirmation(ownership, epoch, candles(first, rows=(), checkpoint=0,
        result=RequestResult(status='provider_maintenance')), now=126001)
    # Model the stream thread's fresh crossing before connection_stop is set.
    assert live.publish_event(ownership, epoch, quote(first, epoch, seq=2, source=127000,
        bid='1.30'), identities, now=127000) == 'rejected_provider_maintenance'
    with pytest.raises(MarketRequestError):
        live.commit_confirmation(ownership, epoch, candles(other), now=127000)
    rows = live.snapshots(now=127000)
    assert rows and all(row['connection_error'] == 'provider_maintenance' for row in rows)
    assert all(not row['quote_ready'] and not row['candle_ready'] for row in rows)
    with factory.begin() as db:
        assert db.scalar(select(SignalRow)) is None
        assert not db.get(LiveState, first.key).ready
    live.disconnected(ownership, epoch, identities, RequestResult(status='unavailable'),
                      now=127001, intentional=True)
    assert live.claim('test-account', now=127002) is None
    due = 127001 + settings.oanda_maintenance_probe_seconds * 1000
    successor = live.claim('test-account', now=due)
    assert successor
    next_epoch = live.begin_connection(successor, identities, now=due)
    assert next_epoch > epoch
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error is None
        assert all(not db.get(LiveState, identity.key).ready for identity in identities.values())


def test_maintenance_confirmation_fences_crossing_and_other_symbol_before_stream_stop(running, monkeypatch):
    factory, ownership, epoch, identities = running
    assert_maintenance_fence(factory, ownership, epoch, identities, monkeypatch)


@pytest.mark.parametrize('stage', ['confirmation', 'startup', 'disconnect', 'intentional_disconnect'])
def test_new_unauthorized_upgrades_maintenance_without_losing_auth_hold(running, stage):
    factory, ownership, epoch, identities = running
    identity = identities['EUR_USD']
    live.commit_confirmation(ownership, epoch, candles(identity, rows=(), checkpoint=0,
        result=RequestResult(status='provider_maintenance')), now=125001)
    result = RequestResult(status='unauthorized')
    if stage == 'confirmation':
        live.commit_confirmation(ownership, epoch, candles(identity, rows=(), checkpoint=0,
            result=result), now=125002)
    elif stage == 'startup':
        live.startup_failed(ownership, 'test-account', result, now=125002)
    else:
        live.disconnected(ownership, epoch, identities, result, now=125002,
                          intentional=stage == 'intentional_disconnect')
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error == 'unauthorized'
    assert live.claim('test-account', now=125003) is None


def test_stream_unauthorized_wins_over_concurrent_rest_maintenance(running, monkeypatch):
    import threading

    factory, ownership, _, identities = running
    confirmed = threading.Event()
    original = oanda_worker.commit_confirmation

    def commit(*args, **kwargs):
        original(*args, **kwargs)
        confirmed.set()

    monkeypatch.setattr(oanda_worker, 'commit_confirmation', commit)

    class Adapter:
        account_id = 'test-account'

        def page(self, identity, start, end):
            return candles(identity, window_start=start, window_end=end, rows=(), checkpoint=start,
                           result=RequestResult(status='provider_maintenance'))

        def stream(self, *args, **kwargs):
            assert confirmed.wait(5)
            raise MarketRequestError(RequestResult(status='unauthorized'))
            yield  # Keep the actual worker's generator contract.

    oanda_worker.collect(Adapter(), ownership, identities, threading.Event())
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error == 'unauthorized'


@pytest.mark.parametrize('statuses,expected', [
    (('provider_maintenance', 'unauthorized'), 'unauthorized'),
    (('unauthorized', 'provider_maintenance'), 'unauthorized'),
    (('provider_maintenance', 'data'), 'provider_maintenance'),
])
def test_already_issued_confirmation_pair_preserves_strongest_fault(running, statuses, expected):
    factory, ownership, epoch, identities = running
    calls = []
    results = dict(zip(identities, statuses))

    class Adapter:
        def page(self, identity, start, end):
            calls.append(identity.provider_symbol)
            status = results[identity.provider_symbol]
            return candles(identity, window_start=start, window_end=end,
                **({'rows': (), 'checkpoint': start} if status != 'data' else {}),
                result=RequestResult(status=status))

    failure = oanda_worker.confirm_pages(Adapter(), ownership, epoch, identities, lambda: False)
    assert failure.status == expected and set(calls) == set(identities)
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error == expected
        assert all(not db.get(LiveState, identity.key).ready for identity in identities.values())


def client_for(*, summary_id="test-account", pricing_code=200, pricing_payload=None):
    calls = []
    catalog = [{"name": "EUR_USD", "displayPrecision": 5}, {"name": "XAU_USD", "displayPrecision": 3}]

    def respond(request):
        calls.append(request.url.path)
        assert request.headers["Authorization"] == "Bearer test"
        if request.url.path.endswith('/summary'):
            return httpx.Response(200, json={"account": {"id": summary_id}})
        if request.url.path.endswith('/instruments'):
            return httpx.Response(200, json={"instruments": catalog})
        assert request.url.path.endswith('/pricing')
        return httpx.Response(pricing_code, json=pricing_payload or {"prices": [
            {"type": "PRICE", "instrument": symbol, "time": "120.0", "tradeable": False,
             "bids": [], "asks": []} for symbol in ('EUR_USD', 'XAU_USD')]})

    return httpx.Client(transport=httpx.MockTransport(respond)), calls


def test_low_frequency_probe_releases_auth_only_after_account_catalog_and_pricing(running, monkeypatch):
    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'), now=125000)
    assert live.claim_auth_probe('test-account', now=125001) is None
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    probe = live.claim_auth_probe('test-account', now=due)
    assert probe and live.claim_auth_probe('test-account', now=due) is None
    assert live.claim('test-account', now=due) is None
    with client_for()[0] as client:
        catalog = OandaPractice(token='test', account_id='test-account', rest_client=client).validate_access(identities)
    live.finish_auth_probe(probe, RequestResult(status='data'), now=due + 1)
    assert len(catalog) == 2
    assert live.claim('test-account', now=due + 2)
    assert all(not row['quote_ready'] and not row['candle_ready'] for row in live.snapshots(now=due + 2))
    with factory.begin() as db:
        assert db.get(PricingOwner, probe[0]).error is None


@pytest.mark.parametrize('code,status', [(401, 'unauthorized'), (403, 'unauthorized'), (503, 'provider_maintenance')])
def test_pricing_failure_keeps_hold_even_with_successful_account_endpoints(running, code, status):
    factory, ownership, epoch, identities = running
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'), now=125000)
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    probe = live.claim_auth_probe('test-account', now=due)
    client, calls = client_for(pricing_code=code, pricing_payload={'errorMessage': 'Service maintenance'})
    with client, pytest.raises(httpx.HTTPStatusError) as failure:
        OandaPractice(token='test', account_id='test-account', rest_client=client).validate_access(identities)
    result = failed_request(failure.value, observed_at=due)
    assert result.status == status
    live.finish_auth_probe(probe, result, now=due + 1)
    assert len(calls) == 3 and all('/accounts/test-account/' in path for path in calls)
    assert live.claim('test-account', now=due + 2) is None
    assert live.claim_auth_probe('test-account', now=due + 2) is None
    with factory.begin() as db:
        assert db.get(PricingOwner, probe[0]).error == 'unauthorized'
    assert all(not row['quote_ready'] for row in live.snapshots(now=due + 2))


@pytest.mark.parametrize('payload', [{'prices': []}, {'prices': [{'type': 'PRICE', 'instrument': 'OTHER'}]}])
def test_empty_or_wrong_pricing_payload_cannot_release_hold(payload):
    with client_for(pricing_payload=payload)[0] as client, pytest.raises(ValueError):
        OandaPractice(token='test', account_id='test-account', rest_client=client).validate_access(['EUR_USD', 'XAU_USD'])


def test_wrong_summary_account_cannot_be_accepted():
    client, calls = client_for(summary_id='another-account')
    with client, pytest.raises(ValueError, match='account'):
        OandaPractice(token='test', account_id='test-account', rest_client=client).validate_access(['EUR_USD'])
    assert len(calls) == 1


def test_dead_probe_and_newer_auth_fault_are_fenced(running):
    _, ownership, epoch, identities = running
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'), now=125000)
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    old = live.claim_auth_probe('test-account', now=due)
    next_due = due + settings.oanda_auth_probe_seconds * 1000
    successor = live.claim_auth_probe('test-account', now=next_due)
    assert successor and old != successor
    with pytest.raises(TimeoutError):
        live.finish_auth_probe(old, RequestResult(status='data'), now=next_due + 1)
    live.finish_auth_probe(successor, RequestResult(status='unauthorized'), now=next_due + 2)
    assert live.claim('test-account', now=next_due + 3) is None


def test_failed_probe_can_use_closed_rate_without_releasing_auth_hold(running):
    factory, ownership, epoch, identities = running
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'), now=125000)
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    probe = live.claim_auth_probe('test-account', now=due)
    live.finish_auth_probe(probe, RequestResult(status='provider_maintenance'), now=due+1,
                           retry_seconds=settings.oanda_closed_probe_seconds)
    with factory.begin() as db:
        owner = db.get(PricingOwner, probe[0])
        assert owner.error == 'unauthorized'
        assert owner.next_at == due + 1 + settings.oanda_closed_probe_seconds * 1000


def test_startup_auth_fault_is_visible_without_catalog(database, monkeypatch):
    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    ownership = live.claim('test-account', now=125000)
    live.startup_failed(ownership, 'test-account', RequestResult(status='unauthorized'), now=125001)
    status = live.provider_status(now=125002)
    assert status['authentication_hold'] and status['error'] == 'unauthorized'
    assert status['next_probe_at'] >= 125001 + settings.oanda_auth_probe_seconds * 1000
    assert 'test-account' not in str(status)


def profile(identity):
    return {'revision': identity.calendar_version, 'closures': [], 'source_session': {
        **{field: getattr(identity, field) for field in ('source', 'channel', 'environment', 'account_scope', 'provider_symbol')},
        'timezone': 'America/New_York', 'reviewed_start': '2026-10-09T00:00:00Z',
        'reviewed_end': '2026-10-12T00:00:00Z', 'evidence_url': 'https://www.oanda.com/sg-en/trading/hours-of-operation/',
        'applicability': 'Controlled finite account-scoped session fixture; no supplier prices',
        'weekly_closures': [{'start': 4*1440+17*60, 'end': 6*1440+17*60+4}],
    }}


def test_verified_weekend_parks_worker_and_never_claims_quote_readiness(database, monkeypatch):
    factory = database
    candidates = {symbol: DatasetIdentity(source='oanda', channel='v20', environment='practice',
        account_scope='sha256:' + hashlib.sha256(b'test-account').hexdigest(), provider_symbol=symbol,
        basis='bid', calendar_version=settings.oanda_calendar_version) for symbol in ('EUR_USD', 'XAU_USD')}
    monkeypatch.setattr(settings, 'oanda_calendar_profiles', {symbol: profile(identity) for symbol, identity in candidates.items()})
    live.ensure_catalog([{'name': 'EUR_USD', 'displayPrecision': 5}, {'name': 'XAU_USD', 'displayPrecision': 3}], 'test-account')
    identities = live.desired_datasets('test-account')
    stamp = int(datetime.fromisoformat('2026-10-10T04:00:00+00:00').timestamp()*1000)
    with factory.begin() as db:
        for identity in identities.values():
            state = db.get(LiveState, identity.key)
            state.epoch = 1
            state.ready = True
            state.connection = 'connected'
            state.heartbeat_at = stamp
    rows = live.snapshots(now=stamp)
    assert all(row['quality'] == 'market_closed' and row['market_session'] == 'closed' for row in rows)
    assert all(not row['quote_ready'] and not row['candle_ready'] for row in rows)
    assert all(row['next_session_at'] > stamp for row in rows)
    delay = oanda_worker.closed_delay(identities, now=stamp)
    assert delay == settings.oanda_closed_probe_seconds
    assert oanda_worker.closed_delay(identities, now=int(datetime.fromisoformat('2026-10-11T21:04:00+00:00').timestamp()*1000)) is None


def test_unknown_and_out_of_scope_calendars_cannot_park_worker(running):
    from alerts.live_session import session_status

    _, _, _, identities = running
    stamp = int(datetime.fromisoformat('2026-10-10T04:00:00+00:00').timestamp()*1000)
    assert oanda_worker.closed_delay(identities, now=stamp) is None
    for identity in identities.values():
        value = profile(identity)
        value['source_session']['account_scope'] = 'sha256:' + hashlib.sha256(b'other').hexdigest()
        assert session_status(identity.model_dump(), value, stamp)['market_session'] == 'unknown'
        assert session_status(identity.model_dump(), profile(identity), stamp + 7*86400000)['market_session'] == 'unknown'


def test_operational_evidence_changes_status_without_reinterpreting_history(running, monkeypatch):
    factory, _, _, identities = running
    from alerts.live_session import session_status
    stamp = int(datetime.fromisoformat('2026-10-10T04:00:00+00:00').timestamp()*1000)
    monkeypatch.setattr(settings, 'oanda_live_session_profiles', {symbol: profile(identity) for symbol, identity in identities.items()})
    assert oanda_worker.closed_delay(identities, now=stamp) == settings.oanda_closed_probe_seconds
    for identity in identities.values():
        with factory.begin() as db:
            assert db.get(Instrument, db.get(MarketDataset, identity.key).instrument_id).calendar_profile == {}
        assert session_status(identity.model_dump(), {}, stamp)['market_session'] == 'closed'
        assert session_status(identity.model_dump() | {'channel': 'other'}, {}, stamp)['market_session'] == 'unknown'
