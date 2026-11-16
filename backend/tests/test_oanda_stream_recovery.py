"""A working account stream must survive independently failing REST access."""

import json
import os
import threading

import httpx
import pytest
from alerts import live_pricing as live
from alerts import oanda_worker as worker
from alerts.config import settings
from alerts.market_contracts import RequestResult
from alerts.oanda_stream import OandaPractice
from alerts.storage import LiveState, PricingOwner, SourceMinuteRevision
from sqlalchemy import select
from test_live_pricing import candles, quote
from test_live_pricing import running as _running
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg


@pytest.fixture(params=["sqlite", "postgres"])
def running(request, monkeypatch):
    if request.param == "postgres":
        if not os.getenv("TEST_POSTGRES_URL"):
            pytest.skip("Requires isolated Ubuntu PostgreSQL")
        factory, _ = request.getfixturevalue("provider_pg")
    else:
        factory = request.getfixturevalue("database")
    return _running.__wrapped__(factory, monkeypatch)


@pytest.mark.parametrize("status", ["unauthorized", "provider_maintenance"])
def test_stream_quotes_survive_confirmation_fault_without_confirming_minutes(running, monkeypatch, status):
    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    identity = identities["EUR_USD"]
    live.commit_confirmation(ownership, epoch, candles(identity, rows=(), checkpoint=0,
        result=RequestResult(status=status)), now=125000)
    assert live.publish_event(ownership, epoch, quote(identity, epoch), identities,
                              now=125001) == "accepted"
    row = next(r for r in live.snapshots(now=125001) if r["dataset_id"] == identity.key)
    assert row["quote_ready"] and not row["candle_ready"]
    assert row["confirmation_error"] == status and not row["authentication_hold"]
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error is None
        assert db.get(LiveState, identity.key).next_confirm_at >= 125000 + 300000
        assert db.scalar(select(SourceMinuteRevision)) is None
    live.commit_confirmation(ownership, epoch, candles(identity), now=126000)
    row = next(r for r in live.snapshots(now=126000) if r["dataset_id"] == identity.key)
    assert row["confirmation_error"] is None and row["candle_ready"]


def test_collect_keeps_publishing_after_confirmation_401(running, monkeypatch):
    _, ownership, _, identities = running
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    confirmed = threading.Event()
    published = []
    stopped = threading.Event()
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    original_commit = worker.commit_confirmation
    original_publish = worker.publish_event

    def commit(*args, **kwargs):
        original_commit(*args, **kwargs)
        confirmed.set()

    def publish(*args, **kwargs):
        published.append(original_publish(*args, **kwargs))
        if len(published) == 2:
            stopped.set()

    monkeypatch.setattr(worker, "commit_confirmation", commit)
    monkeypatch.setattr(worker, "publish_event", publish)

    class Adapter:
        account_id = "test-account"

        def page(self, identity, start, end):
            return candles(identity, rows=(), checkpoint=start, window_start=start,
                window_end=end, result=RequestResult(status="unauthorized"))

        def stream(self, values, *, epoch, stopped):
            assert confirmed.wait(3)
            yield quote(values["EUR_USD"], epoch)
            yield quote(values["EUR_USD"], epoch, seq=2, source=122000)

    worker.collect(Adapter(), ownership, identities, stopped)
    assert published == ["accepted", "accepted"]


def stream_adapter(code=200, *, symbols=("EUR_USD", "XAU_USD"), heartbeat=False):
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if request.url.host != "stream-fxpractice.oanda.com":
            return httpx.Response(401, json={"errorMessage": "Insufficient authorization"})
        if heartbeat:
            body = [{"type": "HEARTBEAT", "time": "125.0"}]
        else:
            body = [{"type": "PRICE", "instrument": symbol, "time": "124.0",
                "tradeable": True, "bids": [{"price": "1.1"}],
                "asks": [{"price": "1.2"}]} for symbol in symbols]
        return httpx.Response(code, content="".join(json.dumps(r) + "\n" for r in body))

    client = httpx.Client(transport=httpx.MockTransport(respond))
    return OandaPractice(token="test", account_id="test-account", rest_client=client,
                         stream_client=client), client, calls


def test_existing_hold_recovers_using_actual_stream_without_rest(running, monkeypatch):
    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    live.disconnected(ownership, epoch, identities, RequestResult(status="unauthorized"), now=125000)
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    monkeypatch.setattr(live, "now_ms", lambda: due)
    probe = live.claim_auth_probe("test-account")
    adapter, client, calls = stream_adapter()
    with client:
        assert worker.probe_authentication(adapter, probe)
    assert calls == ["/v3/accounts/test-account/pricing/stream"]
    assert live.claim("test-account", now=due + 1)
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error is None
        assert all(not db.get(LiveState, i.key).ready for i in identities.values())


@pytest.mark.parametrize("code,heartbeat,symbols", [
    (401, False, ("EUR_USD", "XAU_USD")),
    (200, True, ()),
    (200, False, ("EUR_USD",)),
    (200, False, ("OTHER",)),
])
def test_failed_or_incomplete_stream_probe_cannot_release_hold(running, monkeypatch, code, heartbeat, symbols):
    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    live.disconnected(ownership, epoch, identities, RequestResult(status="unauthorized"), now=125000)
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    monkeypatch.setattr(live, "now_ms", lambda: due)
    probe = live.claim_auth_probe("test-account")
    adapter, client, _ = stream_adapter(code, heartbeat=heartbeat, symbols=symbols)
    with client:
        assert worker.probe_authentication(adapter, probe) is None
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error == "unauthorized"
    assert live.claim_auth_probe("test-account", now=due + 1) is None


def test_worker_restart_uses_registered_identity_instead_of_failing_catalog(running, monkeypatch):
    _, ownership, epoch, identities = running
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    live.disconnected(ownership, epoch, identities, RequestResult(status="unavailable"),
                      now=125000, intentional=True)
    # Intentional release disables instrument demand; re-enable explicitly.
    from alerts.realtime_switch import set_enabled
    from alerts.storage import MarketDataset, transaction
    with transaction() as db:
        for identity in identities.values():
            set_enabled(db, db.get(MarketDataset, identity.key).instrument_id, True, now=125000)
    stopped = threading.Event()
    collected = []
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)

    def collect(adapter, owner, values, stop):
        collected.append(set(values))
        stop.set()

    monkeypatch.setattr(worker, "collect", collect)

    class Adapter:
        account_id = "test-account"

        def catalog(self):
            pytest.fail("Known stream identities must not depend on REST catalog availability")

    worker.run(Adapter(), stopped)
    assert collected == [set(identities)]


def test_registered_stream_identity_never_crosses_account_or_calendar(running, monkeypatch):
    assert live.registered_stream_identities("test-account")
    assert not live.registered_stream_identities("other-account")
    monkeypatch.setattr(settings, "oanda_calendar_version", "different-calendar")
    assert not live.registered_stream_identities("test-account")


def test_bootstrap_catalog_success_cannot_release_hold_when_stream_denies(running, monkeypatch):
    factory, ownership, epoch, identities = running
    monkeypatch.setattr(settings, "oanda_acquisition_mode", "stream")
    monkeypatch.setattr(worker, "closed_delay", lambda *_: None)
    live.disconnected(ownership, epoch, identities, RequestResult(status="unauthorized"), now=125000)
    # A new calendar has no reusable registration and needs catalog bootstrap.
    monkeypatch.setattr(settings, "oanda_calendar_version", "new-calendar")
    due = 125000 + settings.oanda_auth_probe_seconds * 1000
    monkeypatch.setattr(live, "now_ms", lambda: due)
    probe = live.claim_auth_probe("test-account")
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if request.url.host == "stream-fxpractice.oanda.com":
            return httpx.Response(401, json={})
        if request.url.path == "/v3/accounts":
            return httpx.Response(200, json={"accounts": [{"id": "test-account"}]})
        return httpx.Response(200, json={"instruments": [
            {"name": "EUR_USD", "displayPrecision": 5},
            {"name": "XAU_USD", "displayPrecision": 3}]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaPractice(token="test", account_id="test-account",
            rest_client=client, stream_client=client)
        assert worker.probe_authentication(adapter, probe) is None
    assert calls[-1].endswith("/pricing/stream") and len(calls) == 3
    with factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error == "unauthorized"


def test_stream_probe_deadline_closes_continuous_heartbeat_generator(running, monkeypatch):
    from alerts import oanda_stream

    _, _, _, identities = running
    clock = [0]
    closed = []
    monkeypatch.setattr(oanda_stream.time, "monotonic", lambda: clock[0])
    adapter, client, _ = stream_adapter()

    def heartbeats(*args, **kwargs):
        try:
            while True:
                clock[0] += 5
                yield {"type": "heartbeat"}
        finally:
            closed.append(True)

    monkeypatch.setattr(adapter, "stream", heartbeats)
    with client, pytest.raises(TimeoutError):
        adapter.validate_stream_access(identities)
    assert clock[0] == 15 and closed == [True]
