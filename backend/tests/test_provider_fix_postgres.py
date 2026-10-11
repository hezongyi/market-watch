"""Run repaired routing and closed-to-open protections on isolated PostgreSQL."""

import os
from datetime import datetime

import pytest
import test_market_collection_routing as routing
from alerts import live_pricing as live
from alerts.config import settings
from alerts.storage import Instrument, LiveState, MarketDataset, PricingOwner
from test_provider_postgres import provider_pg as _provider_pg

from test_live_pricing import candles, quote
from test_market_contracts import minute
from test_oanda_recovery import profile

provider_pg = _provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Independent PG required"
)


@pytest.mark.parametrize("demand", ["chart", "plan", "viewport", "expired", "forced", "enabled"])
def test_composite_routing_on_postgres(provider_pg, monkeypatch, demand):
    routing.test_composite_never_reaches_ordinary_supplier(provider_pg[0], monkeypatch, demand)


def test_exact_target_and_repair_on_postgres(provider_pg, monkeypatch):
    routing.test_composite_demand_still_routes_to_exact_target_and_old_error_is_cleared_once(
        provider_pg[0], monkeypatch
    )


def test_history_identity_boundary_on_postgres(provider_pg, monkeypatch):
    routing.test_composite_history_jobs_are_not_created_or_dispatched(provider_pg[0], monkeypatch)


def test_other_error_preserved_on_postgres(provider_pg):
    routing.test_unrelated_composite_error_is_preserved(provider_pg[0])


def test_explicit_dataset_boundary_on_postgres(provider_pg, monkeypatch):
    routing.test_explicit_datasets_stay_with_independent_collectors_even_when_forced(
        provider_pg[0], monkeypatch
    )


def test_closed_boundary_open_recovery_requires_current_m1_on_postgres(provider_pg, monkeypatch):
    factory, _ = provider_pg
    stamp = int(datetime.fromisoformat("2026-10-11T20:00:00+00:00").timestamp() * 1000)
    monkeypatch.setattr(live, "now_ms", lambda: stamp)
    monkeypatch.setattr(settings, "oanda_resident_symbols", "EUR_USD")
    live.ensure_catalog([{"name": "EUR_USD", "displayPrecision": 5}], "test-account")
    identities = live.desired_datasets("test-account")
    identity = identities["EUR_USD"]
    monkeypatch.setattr(settings, "oanda_live_session_profiles", {"EUR_USD": profile(identity)})
    with factory.begin() as db:
        d = db.get(MarketDataset, identity.key)
        inst = db.get(Instrument, d.instrument_id)
        before = (d.identity, inst.calendar_profile, inst.last_received)
        inst.quality, inst.error = "error", "unavailable"
    ownership = live.claim("test-account", now=stamp)
    live.park_closed(ownership, identities, 60, now=stamp)
    assert live.snapshots(now=stamp)[0]["market_session"] == "closed"
    boundary = int(datetime.fromisoformat("2026-10-11T21:04:00+00:00").timestamp() * 1000)
    assert live.session_states(identities, now=boundary)["EUR_USD"]["market_session"] == "unknown"
    ownership = live.claim("test-account", now=boundary)
    with pytest.raises(ValueError, match="verified"):
        live.park_closed(ownership, identities, 60, now=boundary)
    at = boundary + 125000
    with factory.begin() as db:
        db.get(PricingOwner, ownership[0]).expires = at + 120000
    epoch = live.begin_connection(ownership, identities, now=at)
    assert live.session_states(identities, now=at)["EUR_USD"]["market_session"] == "scheduled_open"
    cutoff = (at - 5000) // 60000 * 60000
    live.publish_event(
        ownership,
        epoch,
        quote(identity, epoch, source=at - 1000, received_at=at),
        identities,
        now=at,
    )
    assert not live.snapshots(now=at)[0]["candle_ready"]
    live.commit_confirmation(
        ownership,
        epoch,
        candles(
            identity,
            window_start=cutoff - 60000,
            window_end=cutoff,
            observed_at=at,
            rows=(),
            checkpoint=cutoff,
        ),
        now=at,
    )
    assert not live.snapshots(now=at)[0]["candle_ready"]
    live.commit_confirmation(
        ownership,
        epoch,
        candles(
            identity,
            window_start=cutoff - 60000,
            window_end=cutoff,
            observed_at=at,
            rows=(minute(cutoff - 60000, volume="3"),),
            checkpoint=cutoff,
        ),
        now=at,
    )
    assert live.snapshots(now=at)[0]["candle_ready"]
    expiry = int(datetime.fromisoformat("2026-10-12T00:00:00+00:00").timestamp() * 1000)
    assert live.session_states(identities, now=expiry)["EUR_USD"]["market_session"] == "unknown"
    with factory.begin() as db:
        d = db.get(MarketDataset, identity.key)
        inst = db.get(Instrument, d.instrument_id)
        assert (d.identity, inst.calendar_profile) == before[:2]
        assert db.get(LiveState, identity.key).confirmed_end == cutoff
