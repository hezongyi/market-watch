"""Zero-demand idle and intentional subscription changes are healthy lifecycles."""

import threading
from types import SimpleNamespace

from alerts import live_pricing as live
from alerts import oanda_worker as worker
from alerts.config import settings
from alerts.market_contracts import RequestResult
from alerts.storage import Audit, Instrument, LiveState, MarketDataset, PricingOwner
from sqlalchemy import select
from test_live_pricing import running as _running

running = _running


def test_confirmations_overlap_transport_but_commit_serially_with_owner_fencing(monkeypatch):
    identities = {str(i): SimpleNamespace(key=str(i)) for i in range(10)}
    peers = threading.Barrier(2)
    lock = threading.Lock()
    active, peak, completed = 0, 0, []
    caller = threading.get_ident()
    stopped = threading.Event()
    monkeypatch.setattr(worker, "confirmation_window", lambda *_: (0, 60000))

    class Adapter:
        def page(self, identity, left, right):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            peers.wait(timeout=2)
            with lock:
                active -= 1
            return SimpleNamespace(identity=identity, result=RequestResult(status="data"))

    def commit(ownership, epoch, batch):
        assert ownership == ("account", "owner") and epoch == 42
        assert threading.get_ident() == caller
        completed.append(batch.identity.key)

    monkeypatch.setattr(worker, "commit_confirmation", commit)
    assert worker.confirm_pages(Adapter(), ("account", "owner"), 42, identities, stopped.is_set) is None
    assert peak == 2 and sorted(completed) == list(identities)


def test_confirmation_auth_fault_stops_later_batches_and_keeps_exact_result(monkeypatch):
    identities = {str(i): SimpleNamespace(key=str(i)) for i in range(10)}
    calls, committed = [], []
    denied = RequestResult(status="unauthorized")
    monkeypatch.setattr(worker, "confirmation_window", lambda *_: (0, 60000))

    class Adapter:
        def page(self, identity, *_):
            calls.append(identity.key)
            return SimpleNamespace(identity=identity, result=denied)

    monkeypatch.setattr(worker, "commit_confirmation", lambda own, epoch, batch: committed.append(batch.identity.key))
    assert worker.confirm_pages(Adapter(), ("account", "owner"), 42, identities, lambda: False) is denied
    assert len(calls) <= 2 and len(committed) == 1


def test_cancelled_connection_never_commits_completed_peer_requests(monkeypatch):
    stopped = threading.Event()
    calls, committed = [], []
    identities = {str(i): SimpleNamespace(key=str(i)) for i in range(10)}
    monkeypatch.setattr(worker, "confirmation_window", lambda *_: (0, 60000))

    class Adapter:
        def page(self, identity, *_):
            calls.append(identity.key)
            stopped.set()
            return SimpleNamespace(identity=identity, result=RequestResult(status="data"))

    monkeypatch.setattr(worker, "commit_confirmation", lambda *args: committed.append(args))
    assert worker.confirm_pages(Adapter(), ("account", "owner"), 42, identities, stopped.is_set) is None
    assert len(calls) <= 2 and not committed


def test_idle_worker_does_not_claim_account_or_start_stream(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    class Stop:
        def __init__(self):
            self.stopped = False
        def is_set(self):
            return self.stopped
        def wait(self, _):
            self.stopped = True
    class Adapter:
        account_id = "idle-test"
        def catalog(self):
            return [{"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5}]
    monkeypatch.setattr(worker, "claim", lambda _: (_ for _ in ()).throw(AssertionError("Idle must not claim")))
    worker.run(Adapter(), Stop())
    with database.begin() as db:
        assert db.scalar(select(PricingOwner)) is None
        assert not db.scalar(select(Instrument).where(Instrument.source == "oanda")).enabled


def test_idle_grace_resets_when_demand_returns_and_changes_restart_promptly(monkeypatch):
    monkeypatch.setattr(settings, "oanda_idle_grace_seconds", 60)
    current = {"EUR_USD": object()}
    idle, changed = worker.subscription_change(current, {}, None, 100)
    assert idle == 100 and not changed
    assert worker.subscription_change(current, {}, idle, 159) == (100, False)
    assert worker.subscription_change(current, current, idle, 160) == (None, False)
    assert worker.subscription_change(current, {}, None, 200) == (200, False)
    assert worker.subscription_change(current, {}, 200, 260) == (200, True)
    assert worker.subscription_change(current, {"GBP_USD": object()}, None, 100) == (None, True)


def test_intentional_stop_releases_owner_without_fault_or_retry_delay(running):
    factory, ownership, epoch, identities = running
    live.disconnected(ownership, epoch, identities, RequestResult(status="unavailable"),
                      now=125000, intentional=True)
    with factory.begin() as db:
        owner = db.get(PricingOwner, ownership[0])
        assert owner.token is None and owner.expires == 0 and owner.failures == 0
        assert owner.error is None and owner.next_at == 0
        for ident in identities.values():
            state = db.get(LiveState, ident.key)
            assert state.connection == "inactive" and state.error is None and not state.ready
            assert not db.get(Instrument, db.get(MarketDataset, ident.key).instrument_id).enabled
        assert db.scalar(select(Audit).where(Audit.kind == "pricing_idle"))
    assert live.claim("test-account", now=125001)
