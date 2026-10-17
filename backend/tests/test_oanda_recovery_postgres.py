"""Real account row locking, crash takeover, and controlled worker recovery."""
import os
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from alerts import live_pricing as live
from alerts import oanda_worker
from alerts.config import settings
from alerts.market_contracts import RequestResult
from alerts.oanda_stream import OandaPractice
from alerts.storage import LiveState, PricingOwner
from sqlalchemy import select
from test_oanda_recovery import assert_maintenance_fence, client_for, profile
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Isolated Ubuntu PostgreSQL required')


def catalog(account='test-account'):
    live.ensure_catalog([{'name': 'EUR_USD', 'displayPrecision': 5}, {'name': 'XAU_USD', 'displayPrecision': 3}], account)
    return live.desired_datasets(account)


def test_maintenance_fences_all_symbols_and_recovers_only_in_new_epoch(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(live, 'now_ms', lambda: 125000)
    identities = catalog()
    ownership = live.claim('test-account', now=125000)
    epoch = live.begin_connection(ownership, identities, now=125000)
    assert_maintenance_fence(factory, ownership, epoch, identities, monkeypatch)


def test_only_one_auth_probe_and_old_network_result_cannot_clear_successor(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(live, 'now_ms', lambda: 125000)
    identities = catalog()
    ownership = live.claim('test-account')
    epoch = live.begin_connection(ownership, identities)
    live.disconnected(ownership, epoch, identities, RequestResult(status='unauthorized'))
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    with ThreadPoolExecutor(max_workers=4) as pool:
        probes = [value for value in pool.map(lambda _: live.claim_auth_probe('test-account', now=due), range(4)) if value]
    assert len(probes) == 1
    old = probes[0]
    assert live.claim('test-account', now=due + 1) is None
    # Network I/O leaves neither the transaction nor the PostgreSQL row locked.
    with factory.begin() as db:
        db.get(PricingOwner, old[0]).expires = due
    assert live.claim_auth_probe('test-account', now=due + 120001) is None
    successor = live.claim_auth_probe('test-account', now=due + settings.oanda_auth_probe_seconds * 1000)
    assert successor and successor != old
    with pytest.raises(TimeoutError):
        live.finish_auth_probe(old, RequestResult(status='data'), now=due + settings.oanda_auth_probe_seconds * 1000 + 1)
    live.finish_auth_probe(successor, RequestResult(status='unauthorized'), now=due + settings.oanda_auth_probe_seconds * 1000 + 2)
    with factory.begin() as db:
        assert db.get(PricingOwner, old[0]).error == 'unauthorized'
        assert all(not row.ready for row in db.scalars(select(LiveState)))


class ControlledStop:
    def __init__(self, clock, end):
        self.clock, self.end = clock, end

    def is_set(self):
        return self.clock[0] >= self.end

    def wait(self, seconds):
        self.clock[0] += int(seconds * 1000)
        return self.is_set()


def test_worker_startup401_maintenance_then_pricing_access_recovers_without_manual_reset(provider_pg, monkeypatch):
    factory, _ = provider_pg
    clock, calls, collections = [125000], [], []
    monkeypatch.setattr(live, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(oanda_worker, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(settings, 'oanda_account_id', 'test-account')
    interval = settings.oanda_auth_probe_seconds * 1000
    good_client, _ = client_for()

    def respond(request):
        calls.append((clock[0], request.url.path))
        if clock[0] < 125000 + interval:
            return httpx.Response(401)
        if clock[0] < 125000 + 2 * interval and request.url.path.endswith('/pricing'):
            return httpx.Response(503, json={'errorMessage': 'Service maintenance'})
        return good_client.send(request)

    stopped = ControlledStop(clock, 125000 + 2*interval + 3000)

    def collect(adapter, ownership, identities, stop):
        epoch = live.begin_connection(ownership, identities)
        collections.append((clock[0], epoch))
        assert all(not row['quote_ready'] and not row['candle_ready'] for row in live.snapshots())
        clock[0] = stopped.end
        live.disconnected(ownership, epoch, identities, RequestResult(status='unavailable'), intentional=True)

    monkeypatch.setattr(oanda_worker, 'collect', collect)
    with good_client, httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaPractice(token='test', account_id='test-account', rest_client=client, clock=lambda: clock[0])
        oanda_worker.run(adapter, stopped)
    assert len(collections) == 1
    assert len(calls) == 9  # Startup 401, failed 4-endpoint probe, successful 4-endpoint probe.
    assert {at for at, _ in calls} == {125000, 125000 + interval, 125000 + 2*interval}
    with factory.begin() as db:
        owner = db.get(PricingOwner, live.account_key('test-account'))
        assert owner.error is None and owner.epoch == 1


def test_worker_verified_closure_has_no_stream_or_rest_poll_storm(provider_pg, monkeypatch):
    from alerts.market_contracts import DatasetIdentity

    factory, _ = provider_pg
    stamp = 1791604800000  # 2026-10-10 04:00 UTC, Saturday in New York.
    clock, calls = [stamp], []
    monkeypatch.setattr(live, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(oanda_worker, 'now_ms', lambda: clock[0])
    import hashlib
    candidates = {symbol: DatasetIdentity(source='oanda', channel='v20', environment='practice',
        account_scope='sha256:' + hashlib.sha256(b'test-account').hexdigest(), provider_symbol=symbol,
        basis='bid', calendar_version=settings.oanda_calendar_version) for symbol in ('EUR_USD', 'XAU_USD')}
    monkeypatch.setattr(settings, 'oanda_calendar_profiles', {symbol: profile(identity) for symbol, identity in candidates.items()})
    client, _ = client_for()

    def respond(request):
        calls.append(request.url.path)
        return client.send(request)

    monkeypatch.setattr(oanda_worker, 'collect', lambda *_: pytest.fail('No closed-market stream'))
    with client, httpx.Client(transport=httpx.MockTransport(respond)) as rest:
        adapter = OandaPractice(token='test', account_id='test-account', rest_client=rest)
        oanda_worker.run(adapter, ControlledStop(clock, stamp + 2*settings.oanda_closed_probe_seconds*1000 + 1000))
    assert len(calls) == 2 and calls[0] == '/v3/accounts' and calls[1].endswith('/instruments')
    rows = live.snapshots(now=stamp)
    assert rows and all(row['quality'] == 'market_closed' for row in rows)
    assert all(not row['quote_ready'] and not row['candle_ready'] for row in rows)


def test_startup_result_cannot_overwrite_active_new_account_owner(provider_pg):
    catalog()
    old = live.claim('test-account', now=125000)
    new = live.claim('test-account', now=155001)
    assert old and new and old != new
    with pytest.raises(TimeoutError):
        live.startup_failed(old, 'test-account', RequestResult(status='unauthorized'), now=155002)
    with pytest.raises(ValueError):
        live.startup_failed(new, 'other-account', RequestResult(status='unauthorized'), now=155002)
