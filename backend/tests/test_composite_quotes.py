"""Stored prices follow active composite input and owner fences, with no demand."""

import pytest
from alerts import api, composite_quotes
from alerts.chart_series import encode
from alerts.composite_quotes import snapshot
from alerts.config import settings
from alerts.live_pricing import account_key
from alerts.storage import (
    CompositeRevision,
    LiveState,
    MarketComposite,
    MarketDemand,
    PricingOwner,
    RealtimeMapping,
)
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_composite_chart import populated


def quote_state(factory, revision_id, stamp, **changes):
    with factory.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        db.add(
            PricingOwner(
                id=account_key(settings.oanda_account_id),
                token="owner",
                expires=stamp + 30000,
                epoch=3,
            )
        )
        state = db.get(LiveState, mapping.target_dataset_id)
        if state is None:
            state = LiveState(dataset_id=mapping.target_dataset_id)
            db.add(state)
        state.epoch, state.connection = 3, "recovering"
        state.heartbeat_at = state.received_at = stamp
        state.ready = False
        state.quote = {
            "source_time": stamp - 1000,
            "connection_epoch": 3,
            "bid": "1.123456789012345678",
            "ask": "1.123456789012345679",
            "tradeable": True,
        }
        for key, value in changes.items():
            setattr(state, key, value)


def test_live_quote_is_independent_of_recovery_and_exact_input_is_auditable(database, monkeypatch):
    composite_id, revision_id, seam = populated(database, monkeypatch)
    stamp = 200010000
    quote_state(database, revision_id, stamp)
    with database.begin() as db:
        row = snapshot(db, db.get(MarketComposite, composite_id), now=stamp)
        assert row["price"] == "1.123456789012345678"
        assert row["price_type"] == "sampled_bid" and row["quote_ready"]
        assert not row["confirmed_tail_ready"]
        assert row["revision_id"] == revision_id and row["seam"] == seam
        assert row["provenance"]["connection_epoch"] == 3
        assert row["provenance"]["quote"]["source_time"] == stamp - 1000
        assert db.scalar(select(MarketDemand)) is None


@pytest.mark.parametrize(
    "change",
    [
        "epoch",
        "quote_epoch",
        "expired",
        "disconnected",
        "stale",
        "future",
        "received_future",
        "received_stale",
        "inverted",
        "nonfinite",
        "untradeable",
        "account",
        'auth_hold',
        'maintenance',
        'operational_closure',
    ],
)
def test_invalid_or_expired_owner_never_promotes_stream_price(database, monkeypatch, change):
    composite_id, revision_id, seam = populated(database, monkeypatch)
    stamp = 200010000
    quote_state(database, revision_id, stamp)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        live = db.get(LiveState, mapping.target_dataset_id)
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
        if change == 'auth_hold':
            owner.error = 'unauthorized'
        if change == 'maintenance':
            owner.error = 'provider_maintenance'
        if change == 'operational_closure':
            from datetime import UTC, datetime
            from zoneinfo import ZoneInfo

            from alerts.storage import MarketDataset

            target = db.get(MarketDataset, mapping.target_dataset_id)
            at = datetime.fromtimestamp(stamp/1000, UTC)
            day = at.astimezone(ZoneInfo('America/New_York')).weekday()
            monkeypatch.setattr(settings, 'oanda_live_session_profiles', {target.identity['provider_symbol']: {
                'revision': 'test-operational', 'source_session': {
                    **{key: target.identity[key] for key in ('source', 'channel', 'environment', 'account_scope', 'provider_symbol')},
                    'timezone': 'America/New_York', 'reviewed_start': '1970-01-01T00:00:00Z',
                    'reviewed_end': '1970-01-07T00:00:00Z', 'evidence_url': 'https://example.test/reviewed-fixture',
                    'applicability': 'Controlled status fixture; not coverage',
                    'weekly_closures': [{'start': day*1440, 'end': (day+1)*1440}]}}})
        if change == "epoch":
            owner.epoch += 1
        if change == "quote_epoch":
            live.quote = {**live.quote, "connection_epoch": 2}
        if change == "expired":
            owner.expires = stamp
        if change == "disconnected":
            live.connection = "disconnected"
        if change == "received_future":
            live.received_at = stamp + 1
        if change == "received_stale":
            live.received_at = stamp - 15001
        if change == "stale":
            live.quote = {**live.quote, "source_time": stamp - 15001}
        if change == "future":
            live.quote = {**live.quote, "source_time": stamp + 1}
        if change == "inverted":
            live.quote = {**live.quote, "ask": "1.0"}
        if change == "nonfinite":
            live.quote = {**live.quote, "bid": "NaN"}
        if change == "untradeable":
            live.quote = {**live.quote, "tradeable": False}
    if change == "account":
        monkeypatch.setattr(settings, "oanda_account_id", "new-account")
    with database.begin() as db:
        row = snapshot(db, db.get(MarketComposite, composite_id), now=stamp)
        assert not row["quote_ready"]
        assert row["price_type"] == "confirmed_m1_close"
        assert row["observed_at"] == seam + 600000
        assert row["quality"] == ("account_changed" if change == "account" else "stored")
        assert row["provenance"]["source_confirmed"]
        assert db.scalar(select(MarketDemand)) is None


def http_contract(factory, monkeypatch):
    composite_id, revision_id, _ = populated(factory, monkeypatch)
    stamp = 200010000
    quote_state(factory, revision_id, stamp)
    monkeypatch.setattr(composite_quotes, "now_ms", lambda: stamp)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            with factory() as db:
                original = db.scalar(select(func.count()).select_from(MarketComposite))
            response = client.post(
                "/api/market-data/quotes",
                json={"symbols": [encode(composite_id, "composite")], "client": "watchlist"},
            )
            assert response.status_code == 200, response.text
            quote = response.json()[0]
            assert quote["v"]["lp"] == float("1.123456789012345678")
            assert quote["v"]["price_type"] == "sampled_bid"
            assert quote["snapshot"]["price"] == "1.123456789012345678"
            assert "ch" not in quote["v"] and "chp" not in quote["v"]
            assert "抽样Bid" in quote["v"]["description"]
            with factory() as db:
                assert db.scalar(select(MarketDemand)) is None
                assert db.scalar(select(func.count()).select_from(MarketComposite)) == original
    finally:
        api.app.dependency_overrides.clear()


def test_watchlist_http_uses_exact_snapshot_and_never_renews_demand(database, monkeypatch):
    http_contract(database, monkeypatch)
