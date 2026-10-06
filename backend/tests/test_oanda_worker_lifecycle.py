"""Zero-demand idle and intentional subscription changes are healthy lifecycles."""

from alerts import live_pricing as live
from alerts import oanda_worker as worker
from alerts.config import settings
from alerts.market_contracts import RequestResult
from alerts.storage import Audit, Instrument, LiveState, MarketDataset, PricingOwner
from sqlalchemy import select
from test_live_pricing import running as _running

running = _running


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
