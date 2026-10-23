"""Account ownership contention and fencing on the isolated PostgreSQL service."""

import os
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from alerts import live_pricing as live
from alerts import market_resources, oanda_worker
from alerts.market_contracts import RequestResult
from alerts.oanda_stream import OandaPractice
from alerts.storage import LiveMinute, LiveState, Preference, PricingOwner, SourceMinuteRevision
from sqlalchemy import select
from test_live_pricing import quote
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu Docker PostgreSQL"
)


def test_competing_collectors_and_superseded_connection_are_fenced(provider_pg):
    factory, _ = provider_pg
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "XAU_USD", "type": "METAL", "displayPrecision": 3},
    ], "acceptance-test-account")
    identities = live.desired_datasets("acceptance-test-account")
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: live.claim("acceptance-test-account"), range(4)))
    owners = [owner for owner in claims if owner]
    assert len(owners) == 1
    previous = owners[0]
    epoch = live.begin_connection(previous, identities)
    with factory.begin() as db:
        db.get(PricingOwner, previous[0]).expires = 0
    successor = live.claim("acceptance-test-account")
    next_epoch = live.begin_connection(successor, identities)
    assert next_epoch == epoch + 1
    with pytest.raises(TimeoutError):
        live.publish_event(previous, epoch, quote(identities["EUR_USD"], epoch), identities)
    with factory.begin() as db:
        assert all(state.quote == {} for state in db.scalars(select(LiveState)))
    live.publish_event(successor, next_epoch, quote(identities["EUR_USD"], next_epoch), identities)
    with factory.begin() as db:
        assert db.get(LiveState, identities["EUR_USD"].key).quote["connection_epoch"] == next_epoch


def test_snapshot_reads_shared_cooldown_and_expiration_from_postgres(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(live.settings, "oanda_resident_symbols", "EUR_USD,XAU_USD")
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "XAU_USD", "type": "METAL", "displayPrecision": 3},
    ], "acceptance-test-account")
    with factory.begin() as db:
        for state in db.scalars(select(LiveState)):
            state.epoch = 1
            state.connection = "connected"
        db.merge(Preference(key="upstream_slots:oanda", value={"cooldown_until": 155000.5}))
        db.merge(Preference(key="upstream_slots:dukascopy", value={"cooldown_until": 999999}))
    assert [row["cooldown_until"] for row in live.snapshots(now=125000)] == [155001, 155001]
    assert all(row["cooldown_until"] is None for row in live.snapshots(now=155001))


@pytest.mark.parametrize("status", ["unauthorized", "rate_limited"])
def test_controlled_rest_fault_uses_real_commit_fence_and_shared_budget(provider_pg, monkeypatch, status):
    """Inject transport outcomes, never supplier prices, into isolated PG paths."""
    factory, _ = provider_pg
    monkeypatch.setattr(live, "now_ms", lambda: 125000)
    monkeypatch.setattr(market_resources, "now_ms", lambda: 125000)
    monkeypatch.setattr(live.settings, "oanda_recovery_minutes", 2)
    monkeypatch.setattr(live.settings, "oanda_resident_symbols", "EUR_USD,XAU_USD")
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "XAU_USD", "type": "METAL", "displayPrecision": 3},
    ], "fault-contract-account")
    identities = live.desired_datasets("fault-contract-account")
    ownership = live.claim("fault-contract-account")
    epoch = live.begin_connection(ownership, identities)
    result = RequestResult(status=status, retry_at=155000 if status == "rate_limited" else None)
    calls = []

    def respond(request):
        calls.append(request.url.path)
        return httpx.Response(401 if status == "unauthorized" else 429,
            headers={"Retry-After": "30"} if status == "rate_limited" else {}, json={})

    # A 429 sets a shared gate before any subsequent symbol is submitted.
    selected = identities if status == "unauthorized" else {"EUR_USD": identities["EUR_USD"]}
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaPractice(token="injected-fault-contract", account_id="fault-contract-account",
            rest_client=client, stream_client=client, clock=lambda: 125000)
        failure = oanda_worker.confirm_pages(adapter, ownership, epoch, selected, lambda: False)
        if status == 'unauthorized':
            assert failure.status == result.status and failure.retry_at == result.retry_at
            assert failure.operation == 'candles' and failure.http_status == 401
        else:
            assert failure is None
    with factory.begin() as db:
        observations = list(db.scalars(select(LiveMinute)))
        # At 125s the 15s maturity margin admits only [0, 60s).
        assert len(observations) == 1
        assert observations[0].start == 0
        assert len({m.dataset_id for m in observations}) == 1
        assert all(m.failures == 1 and m.confirmed_at is None for m in observations)
        assert db.scalar(select(SourceMinuteRevision)) is None
        assert all(not state.ready for state in db.scalars(select(LiveState)))
        owner = db.get(PricingOwner, ownership[0])
        assert owner.error == ("unauthorized" if status == "unauthorized" else None)
    assert 1 <= len(calls) <= (2 if status == "unauthorized" else 1)
    if status == "unauthorized":
        live.disconnected(ownership, epoch, identities, result, now=125000)
        assert live.claim("fault-contract-account", now=999999) is None
    else:
        identity = identities["EUR_USD"]
        assert live.confirmation_window(ownership, epoch, identity, now=125001) is None
        for kind in ("realtime", "chart", "history"):
            assert market_resources.acquire("oanda", kind, 154999) is None
        assert all(row["cooldown_until"] == 155000 for row in live.snapshots(now=125000))
        token = market_resources.acquire("oanda", "realtime", 155000)
        assert token
        market_resources.release("oanda", token)
