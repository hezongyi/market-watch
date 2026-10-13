"""Sparse source minutes can certify daily OHLC without inventing minute coverage."""

import copy
import hashlib
from datetime import datetime

import httpx
import pytest
from alerts.chart_alert_service import create
from alerts.chart_alert_worker import evaluate
from alerts.composite_chart import chart_page
from alerts.config import settings
from alerts.history_artifacts import artifact_tick
from alerts.oanda_stream import OandaPractice
from alerts.storage import ChartAlert, CompositeJudgment, CompositeRevision, SignalRow, SourceFetch
from sqlalchemy import select
from test_composite_aggregates import drain as aggregate
from test_composite_alerts import config, continuous, live
from test_fixed_indicators import add_tail
from test_market_contracts import identity, minute


def sparse_daily(database, monkeypatch, **changes):
    composite, revision, seam, _ = continuous(database, monkeypatch)
    end = seam + 86400000
    add_tail(database, revision, [minute(end - 60000, volume="3")])
    aggregate(revision, "D1")
    stamp = end + 10
    live(database, revision, stamp, end)
    with database.begin() as db:
        chart_page(db, composite, "D1", count=2, now=stamp)
        parent = db.get(CompositeRevision, revision).history_version_id
        ident = create(db, "sparse-daily", config(composite, timeframe="D1", **changes), at=stamp).id
    while artifact_tick(parent):
        pass
    return ident, composite, revision, seam, end, stamp


def source_adapter(seam, end, **changes):
    body = {"instrument": "EUR_USD", "granularity": "D", "candles": [{
        "time": str(seam // 1000), "complete": True, "volume": 11,
        "bid": {"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.11"}}]}
    for key, value in changes.items():
        if key in ("instrument", "granularity", "candles"):
            body[key] = value
        else:
            body["candles"][0][key] = value
    calls = []

    def get(request):
        calls.append(request)
        assert request.url.path == f"/v3/accounts/{settings.oanda_account_id}/instruments/EUR_USD/candles"
        assert dict(request.url.params) == {"granularity": "D", "price": "B", "smooth": "false",
            "dailyAlignment": "17", "alignmentTimezone": "America/New_York", "weeklyAlignment": "Sunday",
            "from": str(seam // 1000), "to": str(end // 1000)}
        return httpx.Response(200, json=body)

    client = httpx.Client(transport=httpx.MockTransport(get))
    return OandaPractice(token="test-token", account_id=settings.oanda_account_id,
                         rest_client=client, clock=lambda: end + 10), client, calls


def test_sparse_day_waits_for_price_evidence_without_marking_fresh_quotes_stale(database, monkeypatch):
    ident, _, _, _, _, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        row = db.get(ChartAlert, ident)
        assert row.health == "coverage_pending"
        assert row.runtime["quote_health"] == "ready"
        assert row.state == {}
        assert db.scalar(select(SourceFetch).where(SourceFetch.id.startswith("ohlc:"))) is not None


def test_matching_account_native_day_baselines_then_allows_new_cross_without_filling_minutes(database, monkeypatch):
    from alerts import composite_price_confirmation as prices

    ident, composite, revision, seam, end, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    adapter, client, calls = source_adapter(seam, end)
    try:
        assert prices.once(adapter)
        assert not prices.once(adapter), "shared positive evidence does not refetch on each evaluation"
    finally:
        client.close()
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        row = db.get(ChartAlert, ident)
        assert row.health == "ready" and row.state["sequence"] == end
        assert db.scalar(select(SignalRow)) is None
        judgment = db.scalar(select(CompositeJudgment))
        proof = judgment.evidence["dependencies"][0]["price_confirmation"]
        assert proof["kind"] == "native_ohlc_match" and proof["source_id"]
        bar = chart_page(db, composite, "D1", count=2, now=stamp)["bars"][-1]
        assert not bar["coverage_complete"] and not bar["complete"]
        assert bar["unknown_minutes"] > 0 and bar["volume"] is None
        first_evidence = copy.deepcopy(judgment.evidence)
    assert len(calls) == 1
    next_end = end + 86400000
    add_tail(database, revision, [minute(end, volume="3", close="1.119"),
                                 minute(next_end - 60000, volume="3", close="1.119")])
    aggregate(revision, "D1")
    live(database, revision, next_end + 10, next_end)
    with database.begin() as db:
        assert evaluate(db, ident, now=next_end + 10) == []
        assert db.get(ChartAlert, ident).health == "coverage_pending"
    adapter, client, _ = source_adapter(end, next_end, bid={"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.119"})
    try:
        assert prices.once(adapter)
    finally:
        client.close()
    with database.begin() as db:
        assert len(evaluate(db, ident, now=next_end + 10)) == 1
        assert evaluate(db, ident, now=next_end + 10) == []
        assert db.get(ChartAlert, ident).count == 1
        assert db.scalar(select(CompositeJudgment).order_by(CompositeJudgment.event_time)).evidence == first_evidence


@pytest.mark.parametrize("changes", [
    {"complete": False}, {"time": "0"}, {"instrument": "XAU_USD"}, {"granularity": "M1"},
    {"candles": []}, {"bid": {"o": "1.10", "h": "1.13", "l": "1.09", "c": "1.11"}},
])
def test_unconfirmed_wrong_identity_or_mismatching_prices_never_release_rule(database, monkeypatch, changes):
    from alerts import composite_price_confirmation as prices

    ident, _, _, seam, end, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    adapter, client, _ = source_adapter(seam, end, **changes)
    try:
        assert prices.once(adapter)
    finally:
        client.close()
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        row = db.get(ChartAlert, ident)
        assert row.health == "coverage_pending" and row.state == {}
        assert db.scalar(select(SignalRow)) is None


def test_native_price_proof_does_not_release_indicator_dependencies_or_disconnected_quotes(database, monkeypatch):
    condition = {"relation": "cross_up", "left": {"kind": "indicator", "indicator":
        {"name": "EMA", "params": {"period": 2}}}, "right": {"kind": "constant", "value": "1.115"}}
    ident, _, revision, _, end, stamp = sparse_daily(database, monkeypatch, condition=condition)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).health == "coverage_pending"
        assert db.scalar(select(SourceFetch).where(SourceFetch.id.startswith("ohlc:"))) is None, "OHLC proof does not certify recursive indicator coverage"
    live(database, revision, stamp, end, connected=False)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).health == "stale"


def test_account_switch_cannot_fetch_or_reuse_price_evidence(database, monkeypatch):
    from alerts import composite_price_confirmation as prices

    ident, _, _, seam, end, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    adapter, client, calls = source_adapter(seam, end)
    adapter.account_id = "another-account"
    try:
        assert prices.once(adapter)
    finally:
        client.close()
    assert calls == [], "account mismatch is rejected before supplier I/O"
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        assert db.get(ChartAlert, ident).health == "coverage_pending"
        assert db.scalar(select(SignalRow)) is None


@pytest.mark.parametrize("status", ["paused", "expired"])
def test_background_source_demand_stops_with_its_last_active_rule(database, monkeypatch, status):
    from alerts import composite_price_confirmation as prices

    ident, _, _, seam, end, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        row = db.get(ChartAlert, ident)
        if status == "expired":
            row.expires_at = stamp - 1
        else:
            row.status = status
    adapter, client, calls = source_adapter(seam, end)
    try:
        assert not prices.once(adapter)
    finally:
        client.close()
    assert calls == []


def test_corrected_minutes_require_new_match_and_never_replay_old_cross(database, monkeypatch):
    from alerts import composite_price_confirmation as prices

    ident, _, revision, seam, end, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    adapter, client, _ = source_adapter(seam, end)
    try:
        assert prices.once(adapter)
    finally:
        client.close()
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        original = copy.deepcopy(db.scalar(select(CompositeJudgment)).evidence)
    add_tail(database, revision, [minute(end - 60000, volume="3", close="1.119")])
    aggregate(revision, "D1")
    live(database, revision, stamp + 1, end)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp + 1) == []
        assert db.get(ChartAlert, ident).health == "coverage_pending"
        task = db.scalar(select(SourceFetch).where(SourceFetch.id.startswith("ohlc:")))
        task.fetched_at = 0  # The actual retry is bounded to one per minute.
    adapter, client, _ = source_adapter(seam, end, bid={"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.119"})
    try:
        assert prices.once(adapter)
    finally:
        client.close()
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp + 1) == []
        assert db.get(ChartAlert, ident).health == "ready"
        assert db.get(ChartAlert, ident).runtime["readiness"]["last_outcome"] == "recovery_baseline"
        assert db.scalar(select(SignalRow)) is None
        assert db.scalar(select(CompositeJudgment).order_by(CompositeJudgment.input_revision)).evidence == original


def test_duplicate_workers_and_obsolete_lease_cannot_publish(database, monkeypatch):
    from alerts import composite_price_confirmation as prices

    ident, _, _, _, _, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    ownership = prices.claim()
    assert ownership and prices.claim() is None
    with database.begin() as db:
        db.get(SourceFetch, ownership["id"]).lease_token = "new-owner"
    with pytest.raises(TimeoutError, match="superseded"):
        prices.commit(ownership, None, "empty_success")


@pytest.mark.parametrize("date", ["2026-03-07T22:00:00+00:00", "2026-10-31T21:00:00+00:00"])
def test_native_daily_confirmation_preserves_dst_interval_boundaries(date):
    from alerts.composite_price_confirmation import _source
    from alerts.composite_series import period

    start = int(datetime.fromisoformat(date).timestamp() * 1000)
    left, end = period(start, "D1", "ny17")
    assert left == start and end - start in (23 * 3600000, 25 * 3600000)
    account = "composite-test-account"
    source = _source(identity(source="oanda", channel="v20",
        environment="practice", provider_symbol="EUR_USD",
        account_scope="sha256:" + hashlib.sha256(account.encode()).hexdigest()), "ny17")

    def get(request):
        assert request.url.params["from"] == str(start // 1000)
        assert request.url.params["to"] == str(end // 1000)
        return httpx.Response(200, json={"instrument":"EUR_USD", "granularity":"D", "candles":[{
            "time":str(start // 1000), "complete":True,
            "bid":{"o":"1.10", "h":"1.12", "l":"1.09", "c":"1.11"}}]})

    with httpx.Client(transport=httpx.MockTransport(get)) as client:
        adapter = OandaPractice(token="test-token", account_id=account,
                                rest_client=client, clock=lambda:end + 10)
        proof = adapter.confirm_daily_price(source, start, end)
        assert (proof["start"], proof["end"]) == (start, end) and proof["complete"]


def test_successfully_confirmed_sparse_day_still_requires_fresh_next_bar(database, monkeypatch):
    from alerts import composite_price_confirmation as prices

    ident, _, revision, seam, end, stamp = sparse_daily(database, monkeypatch)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
    adapter, client, _ = source_adapter(seam, end)
    try:
        assert prices.once(adapter)
    finally:
        client.close()
    future = stamp + 86400000 + 60000  # Beyond the existing close-boundary grace.
    live(database, revision, future, end)
    with database.begin() as db:
        assert evaluate(db, ident, now=future) == []
        assert db.get(ChartAlert, ident).health == "stale"
        assert db.get(ChartAlert, ident).runtime["quote_health"] == "ready"
        assert db.scalar(select(SignalRow)) is None
