"""Zero-demand idle and intentional subscription changes are healthy lifecycles."""

import threading
from contextlib import nullcontext
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
    identities = {str(i): SimpleNamespace(key=str(i), provider_symbol=str(i)) for i in range(10)}
    peers = threading.Barrier(2)
    lock = threading.Lock()
    active, peak, completed = 0, 0, []
    caller = threading.get_ident()
    stopped = threading.Event()
    monkeypatch.setattr(worker, "confirmation_window", lambda *_: (0, 60000))
    monkeypatch.setattr(worker, "session_states", lambda items: {key: {"market_session": "open"} for key in items})

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
    identities = {str(i): SimpleNamespace(key=str(i), provider_symbol=str(i)) for i in range(10)}
    calls, committed = [], []
    denied = RequestResult(status="unauthorized")
    monkeypatch.setattr(worker, "confirmation_window", lambda *_: (0, 60000))
    monkeypatch.setattr(worker, "session_states", lambda items: {key: {"market_session": "open"} for key in items})

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
    identities = {str(i): SimpleNamespace(key=str(i), provider_symbol=str(i)) for i in range(10)}
    monkeypatch.setattr(worker, "confirmation_window", lambda *_: (0, 60000))
    monkeypatch.setattr(worker, "session_states", lambda items: {key: {"market_session": "open"} for key in items})

    class Adapter:
        def page(self, identity, *_):
            calls.append(identity.key)
            stopped.set()
            return SimpleNamespace(identity=identity, result=RequestResult(status="data"))

    monkeypatch.setattr(worker, "commit_confirmation", lambda *args: committed.append(args))
    assert worker.confirm_pages(Adapter(), ("account", "owner"), 42, identities, stopped.is_set) is None
    assert len(calls) <= 2 and not committed


def test_idle_worker_serializes_catalog_then_releases_lease_without_stream(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    class Stop:
        stopped = False
        def is_set(self):
            return self.stopped
    stopped = Stop()
    catalogs, parked = [], []
    class Adapter:
        account_id = "idle-test"
        def catalog(self):
            catalogs.append(True)
            return [{"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5}]
        def stream(self, *args, **kwargs):
            raise AssertionError("Idle must not stream")
    original_park = worker.park_closed
    def park(ownership, identities, delay):
        assert not identities and delay == 1
        original_park(ownership, identities, delay)
        parked.append(ownership)
        stopped.stopped = True
    monkeypatch.setattr(worker, "park_closed", park)
    monkeypatch.setattr(worker, "collect", lambda *_: (_ for _ in ()).throw(AssertionError("Idle must not collect")))
    worker.run(Adapter(), stopped)
    assert len(catalogs) == len(parked) == 1
    with database.begin() as db:
        owner = db.get(PricingOwner, live.account_key("idle-test"))
        assert owner is not None and owner.token is None and owner.expires == 0
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


def test_rest_collect_fences_response_when_cancelled_during_http(monkeypatch):
    stopped = threading.Event()
    identity = SimpleNamespace(provider_symbol="EUR_USD")
    identities = {"EUR_USD": identity}
    disconnected = []
    published = []

    monkeypatch.setattr(worker, "begin_connection", lambda *_: 7)
    monkeypatch.setattr(worker, "renew", lambda *_: True)
    monkeypatch.setattr(worker, "desired_datasets", lambda *_: identities)
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    monkeypatch.setattr(worker, "lane", lambda *_: nullcontext())
    monkeypatch.setattr(worker.CandleSpec, "from_dataset", lambda *_: SimpleNamespace(key="EUR_USD"))
    monkeypatch.setattr(worker.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(worker, "publish_rest_batch", lambda *args, **kwargs: published.append(args))
    monkeypatch.setattr(worker, "disconnected", lambda *args, **kwargs: disconnected.append((args, kwargs)))

    class Adapter:
        account_id = "test-account"

        def latest(self, *args, **kwargs):
            stopped.set()
            return SimpleNamespace(result=RequestResult(status="data"))

    worker.collect_rest(Adapter(), ("account", "owner"), identities, stopped)
    assert not published
    assert disconnected and disconnected[0][0][3].status == "unavailable"
    assert disconnected[0][1]["intentional"] is True


def test_rest_collect_drains_checkpoint_pages_while_latest_cadence_runs(monkeypatch):
    """Latest snapshots must not be the only recovery path after reconnect."""
    stopped = threading.Event()
    confirmation = threading.Event()
    identity = SimpleNamespace(provider_symbol="EUR_USD", key="dataset")
    identities = {"dataset": identity}
    disconnected = []

    monkeypatch.setattr(worker, "begin_connection", lambda *_: 7)
    monkeypatch.setattr(worker, "renew", lambda *_: True)
    monkeypatch.setattr(worker, "desired_for_mode", lambda *_: identities)
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    monkeypatch.setattr(worker, "disconnected", lambda *args, **kwargs: disconnected.append((args, kwargs)))
    monkeypatch.setattr(worker, "CandleSpec", SimpleNamespace(from_dataset=lambda *_: SimpleNamespace(key="spec")))

    def confirm(*args):
        confirmation.set()
        return None

    monkeypatch.setattr(worker, "confirm_pages", confirm)

    class Adapter:
        account_id = "test-account"

        def page(self, *_):
            raise AssertionError("confirm_pages is the owned recovery entry point")

        def latest(self, *_args, **_kwargs):
            assert confirmation.wait(2), "latest loop started without the recovery thread"
            stopped.set()
            return SimpleNamespace(result=RequestResult(status="data"))

    worker.collect_rest(Adapter(), ("account", "owner"), identities, stopped)
    assert confirmation.is_set() and disconnected


def test_rest_collect_batches_live_and_native_specs_by_request_group(monkeypatch):
    stopped = threading.Event()
    live_identity = SimpleNamespace(provider_symbol="EUR_USD", key="live")
    live_spec = SimpleNamespace(key="live-spec", group_key="same-group")
    native_spec = SimpleNamespace(key="native-h1", group_key="same-group")
    identities = {"live": live_identity}
    native = (("provider-h1", "H1", native_spec),)
    calls, live_published, native_published = [], [], []

    monkeypatch.setattr(settings, "oanda_acquisition_mode", "rest_batch")
    monkeypatch.setattr(worker, "begin_connection", lambda *_: 7)
    monkeypatch.setattr(worker, "renew", lambda *_: True)
    monkeypatch.setattr(worker, "desired_for_mode", lambda *_: identities)
    monkeypatch.setattr(worker, "native_specs", lambda *_: native)
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    monkeypatch.setattr(worker, "CandleSpec", SimpleNamespace(
        from_dataset=lambda *_: live_spec,
    ))
    def publish_live(*args, **kwargs):
        live_published.append((args, kwargs))
        stopped.set()

    monkeypatch.setattr(worker, "publish_rest_batch", publish_live)
    monkeypatch.setattr(worker, "publish_native_rest_batch",
                        lambda *args, **kwargs: native_published.append((args, kwargs)))
    monkeypatch.setattr(worker, "disconnected", lambda *args, **kwargs: None)

    class Adapter:
        account_id = "test-account"

        def latest(self, specs, **kwargs):
            calls.append((specs, kwargs))
            return SimpleNamespace(result=RequestResult(status="data"))

    worker.collect_rest(Adapter(), ("account", "owner"), identities, stopped, native)
    assert len(calls) == 1
    assert {spec.key for spec in calls[0][0]} == {"live-spec", "native-h1"}
    assert len(live_published) == len(native_published) == 1
    assert live_published[0][1]["demand_revision"] == native_published[0][1]["demand_revision"]


def test_rest_collect_preserves_terminal_auth_failure_for_disconnect(monkeypatch):
    stopped = threading.Event()
    identity = SimpleNamespace(provider_symbol="EUR_USD")
    identities = {"EUR_USD": identity}
    disconnected = []
    published = []

    monkeypatch.setattr(worker, "begin_connection", lambda *_: 9)
    monkeypatch.setattr(worker, "renew", lambda *_: True)
    monkeypatch.setattr(worker, "desired_datasets", lambda *_: identities)
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    monkeypatch.setattr(worker, "lane", lambda *_: nullcontext())
    monkeypatch.setattr(worker.CandleSpec, "from_dataset", lambda *_: SimpleNamespace(key="EUR_USD"))
    monkeypatch.setattr(worker.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(worker, "publish_rest_batch", lambda *args, **kwargs: published.append(args))
    monkeypatch.setattr(worker, "disconnected", lambda *args, **kwargs: disconnected.append((args, kwargs)))

    class Adapter:
        account_id = "test-account"

        def latest(self, *args, **kwargs):
            return SimpleNamespace(result=RequestResult(status="unauthorized"))

    worker.collect_rest(Adapter(), ("account", "owner"), identities, stopped)
    assert published
    assert disconnected and disconnected[0][0][3].status == "unauthorized"
    assert disconnected[0][1]["intentional"] is False


def test_rest_collect_uses_fixed_cadence_and_skips_after_slow_request(monkeypatch):
    clock = [0.0]
    starts = []
    published = []

    class Stop:
        stopped = False

        def is_set(self):
            return self.stopped

    stopped = Stop()

    class FakeEvent:
        def __init__(self):
            self.value = False

        def is_set(self):
            return self.value

        def set(self):
            self.value = True

        def wait(self, seconds=0):
            clock[0] += seconds or 0
            return self.value

    identity = SimpleNamespace(provider_symbol="EUR_USD")
    identities = {"EUR_USD": identity}
    monkeypatch.setattr(worker.threading, "Event", FakeEvent)
    monkeypatch.setattr(worker, "begin_connection", lambda *_: 7)
    monkeypatch.setattr(worker, "renew", lambda *_: True)
    monkeypatch.setattr(worker, "desired_datasets", lambda *_: identities)
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    monkeypatch.setattr(worker, "lane", lambda *_: nullcontext())
    monkeypatch.setattr(worker.CandleSpec, "from_dataset", lambda *_: SimpleNamespace(key="EUR_USD"))
    monkeypatch.setattr(worker.time, "monotonic", lambda: clock[0])
    def publish(*args, **kwargs):
        published.append(args)
        if len(published) == 2:
            stopped.stopped = True

    monkeypatch.setattr(worker, "publish_rest_batch", publish)
    monkeypatch.setattr(worker, "disconnected", lambda *args, **kwargs: None)

    class Adapter:
        account_id = "test-account"

        def latest(self, *args, **kwargs):
            starts.append(clock[0])
            clock[0] += 3.0  # exceeds the configured two-second cadence
            return SimpleNamespace(result=RequestResult(status="data"))

    monkeypatch.setattr(settings, "oanda_rest_interval_seconds", 2)
    worker.collect_rest(Adapter(), ("account", "owner"), identities, stopped)
    assert starts == [0.0, 4.0]
    assert len(published) == 2
