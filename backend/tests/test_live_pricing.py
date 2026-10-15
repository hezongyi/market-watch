import hashlib

import pytest
from alerts import live_pricing as live
from alerts.config import settings
from alerts.market_contracts import CandleBatch, QuoteEvent, RequestResult
from alerts.oanda_rest_batch import live_demand_revision
from alerts.service import create_watch
from alerts.storage import Audit, Bar, LiveState, PricingOwner, SignalRow, Watch
from sqlalchemy import select
from test_market_contracts import minute


@pytest.fixture
def running(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_recovery_minutes", 2)
    monkeypatch.setattr("alerts.live_pricing.now_ms", lambda: 125000)
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "XAU_USD", "type": "METAL", "displayPrecision": 3},
        {"name": "GBP_USD", "type": "CURRENCY", "displayPrecision": 5},
    ], "test-account")
    identities = live.desired_datasets("test-account")
    ownership = live.claim("test-account", now=125000)
    epoch = live.begin_connection(ownership, identities, now=125000)
    return database, ownership, epoch, identities


def quote(identity, epoch, seq=1, source=121000, bid="1.10", **changes):
    return QuoteEvent(**dict(identity=identity, bid=bid, ask="1.40", source_time=source,
                            received_at=source + 1000, tradeable=True,
                            connection_epoch=epoch, sequence=seq) | changes)


def candles(identity, **changes):
    return CandleBatch(**dict(identity=identity, window_start=0, window_end=120000,
        observed_at=125000, rows=(minute(), minute(60000)), result=RequestResult(status="data"),
        volume_kind="price_count", volume_unit="quotes", checkpoint=120000) |
        {"rows": (minute(volume="3"), minute(60000, volume="4"))} | changes)


def test_one_account_has_one_owner_and_old_owner_cannot_publish_after_expiry(running):
    db_factory, ownership, epoch, identities = running
    assert live.claim("test-account", now=125001) is None
    second = live.claim("test-account", now=155001)
    assert second and second[1] != ownership[1]
    with pytest.raises(TimeoutError, match="expired"):
        live.publish_event(ownership, epoch, quote(identities["EUR_USD"], epoch), identities, now=155002)
    with db_factory.begin() as db:
        assert db.get(LiveState, identities["EUR_USD"].key).quote == {}
    assert not live.renew(ownership, now=155002)


def test_browser_demand_and_alerts_join_resident_instruments_without_extra_owner(running):
    db_factory, _, _, identities = running
    assert set(identities) == {"EUR_USD", "XAU_USD"}
    from alerts.storage import MarketDataset

    with db_factory.begin() as db:
        dataset = next(row for row in db.scalars(select(MarketDataset)) if row.logical_symbol == "GBPUSD")
        create_watch(db, dataset.instrument_id, "always active", {"kind": "price", "timeframe": "tick",
                    "level": "1.25"}, armed_at=0)
    assert set(live.desired_datasets("test-account")) == {"EUR_USD", "XAU_USD", "GBP_USD"}


def test_quotes_are_source_isolated_forming_has_no_fake_volume_and_duplicate_order_is_fenced(running):
    db_factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=2, source=122000, bid="1.20"),
                       identities, now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=1, source=121000, bid="1.30"),
                       identities, now=125000)
    with db_factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert state.quote["bid"] == "1.20"
        assert state.forming["high"] == "1.20" and state.forming["low"] == "1.10"
        assert state.forming["volume"] is None and not state.forming["complete"]
        assert not state.forming["observation_complete"]
        assert db.scalar(select(Bar)) is None
        assert db.get(LiveState, identities["XAU_USD"].key).quote == {}
    report = live.measurements(identity.key)
    assert report["quotes"]["samples"] == 2
    assert report["quotes"]["p95_age_ms"] == 1000
    assert report["quotes"]["max_interarrival_ms"] == 1000


def test_publish_reports_committed_outcomes_without_refreshing_rejected_quotes(running):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]

    def publish(event):
        return live.publish_event(ownership, epoch, event, identities, now=125000)

    assert publish(quote(identity, epoch, seq=5)) == "accepted"
    # Old source takes precedence when both source time and sequence are old.
    assert publish(quote(identity, epoch, seq=4, source=120000)) == "rejected_old_source"
    assert publish(quote(identity, epoch, seq=5, source=122000)) == "rejected_sequence"
    assert publish(quote(identity, epoch, seq=6, received_at=124000)) == "rejected_duplicate"
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert state.quote["source_time"] == 121000 and state.received_at == 122000
    # An unchanged price with a newer source timestamp is an accepted update.
    assert publish(quote(identity, epoch, seq=7, source=122000)) == "accepted"
    assert publish({"type": "heartbeat", "received_at": 124000,
                    "connection_epoch": epoch}) == "heartbeat"
    assert live.measurements(identity.key)["quotes"]["samples"] == 2


def test_old_connection_epoch_messages_are_rejected_even_when_token_is_same(running):
    _, ownership, epoch, identities = running
    next_epoch = live.begin_connection(ownership, identities, now=126000)
    assert next_epoch == epoch + 1
    with pytest.raises(TimeoutError):
        live.publish_event(ownership, epoch, quote(identities["EUR_USD"], epoch), identities, now=126000)


def test_heartbeat_does_not_prove_quotes_or_minute_readiness(running):
    _, ownership, epoch, identities = running
    live.publish_event(ownership, epoch, {"type": "heartbeat", "received_at": 125000,
                       "connection_epoch": epoch}, identities, now=125000)
    states = live.snapshots(now=125000)
    assert all(row["quality"] == "recovering" for row in states if row["logical_symbol"] in ("EURUSD", "XAUUSD"))
    assert all(not row["recovery_ready"] and row["last_confirmed_m1"] == 0 for row in states)
    assert all(row["quote"] == {} for row in states)


def test_expired_connection_cannot_report_candle_judgment_ready(running):
    _, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    state = next(row for row in live.snapshots(now=150000) if row["dataset_id"] == identity.key)
    assert state["quality"] == "unavailable"
    assert not state["quote_ready"]
    assert not state["candle_ready"]


def test_recovery_and_confirmation_restore_source_state_without_historical_notifications(running):
    db_factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.storage import MarketDataset

    with db_factory.begin() as db:
        instrument = db.get(MarketDataset, identity.key).instrument_id
        create_watch(db, instrument, "closed crossing", {"kind": "price", "timeframe": "M1",
            "direction": "buy", "level": "1.105"}, armed_at=0, use_history=False)
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    assert live.confirmation_window(ownership, epoch, identity, now=125000) == (0, 120000)
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with db_factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert state.ready and state.confirmed_end == 120000 and state.connection == "connected"
        assert state.next_confirm_at == 185000
        assert db.scalar(select(SignalRow)) is None
        assert db.scalar(select(Watch)).state["last_event"] == 120000
        assert db.scalar(select(Audit).where(Audit.kind == "pricing_recovered")) is not None
    report = live.measurements(identity.key)
    assert report["confirmed"] == 1 and report["missing"] == 0
    assert report["recovery_confirmed"] == 1 and report["late_over_30s"] == 0


def test_actual_confirmation_transaction_records_canonical_minutes_and_fences_old_epoch(running):
    factory, ownership, epoch, identities = running
    from alerts.confirmed_minutes import rows
    from alerts.source_registry import collection_identity
    from alerts.storage import SourceMinuteRevision
    from sqlalchemy import func

    identity = identities["EUR_USD"]
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with factory.begin() as db:
        stored = list(rows(db, collection_identity(identity).key, 0, 120000))
        assert len(stored) == 2 and stored[0]["volume_kind"] == "price_count"
        assert stored[0]["volume"] == "3"
    successor = live.begin_connection(ownership, identities, now=126000)
    with pytest.raises(TimeoutError):
        live.commit_confirmation(ownership, epoch, candles(identity), now=126000)
    assert successor == epoch + 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceMinuteRevision)) == 2


def test_empty_success_cannot_restore_open_market_and_failed_attempts_remain_in_denominator(running):
    _, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    failed = candles(identity, rows=(), result=RequestResult(status="timeout"))
    live.commit_confirmation(ownership, epoch, failed, now=125000)
    empty = candles(identity, rows=(), result=RequestResult(status="empty_success"))
    live.commit_confirmation(ownership, epoch, empty, now=135000)
    report = live.measurements(identity.key)
    assert report["failed_attempts"] == 2 and report["missing"] == 1
    state = next(row for row in live.snapshots(now=135000) if row["dataset_id"] == identity.key)
    assert not state["recovery_ready"]


def test_confirmation_timing_records_completed_ingestion_and_evaluation(running, monkeypatch):
    from alerts.storage import LiveMinute

    db_factory, ownership, epoch, identities = running
    clock = iter((125000, 125050, 125120))
    monkeypatch.setattr(live, "now_ms", lambda: next(clock))
    live.commit_confirmation(ownership, epoch, candles(identities["EUR_USD"]))
    with db_factory.begin() as db:
        minute_row = db.scalar(select(LiveMinute).where(LiveMinute.start == 60000))
        audit = db.scalar(select(Audit).where(Audit.kind == "pricing_confirmed"))
        assert minute_row.confirmed_at == 125050
        assert audit.details["transport_received_at"] == 125000
        assert audit.details["write_completed_at"] == 125050
        assert audit.details["evaluation_completed_at"] == 125120
        assert audit.details["m1_to_evaluation_ms"] == 5120
        assert audit.details["processing_ms"] == 120


def test_nontradeable_quote_cannot_certify_a_whole_closed_minute(running):
    from alerts.storage import LiveMinute

    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    live.publish_event(ownership, epoch, quote(identity, epoch, source=65000, tradeable=False),
                       identities, now=125000)
    live.commit_confirmation(ownership, epoch,
        candles(identity, rows=(), result=RequestResult(status="empty_success")), now=125000)
    with factory.begin() as db:
        metric = db.scalar(select(LiveMinute).where(LiveMinute.start == 60000))
        assert metric.expected is None
        assert not db.get(LiveState, identity.key).ready
    assert live.measurements(identity.key)["not_tradeable"] == 0


def test_small_latency_samples_do_not_hide_the_slowest_confirmation(running, monkeypatch):
    from alerts.storage import LiveMinute

    factory, _, _, identities = running
    monkeypatch.setattr(live, "now_ms", lambda: 400000)
    with factory.begin() as db:
        for index, delay in enumerate((1000, 2000, 3000, 4000, 50000)):
            start = index * 60000
            db.add(LiveMinute(dataset_id=identities["EUR_USD"].key, start=start,
                expected=True, expectation="observed_source_tradeable", quote_count=1,
                confirmed_at=start + 60000 + delay, first_attempt=start + 65000,
                last_attempt=start + 65000))
    result = live.measurements(identities["EUR_USD"].key)
    assert result["p95_ms"] == result["p99_ms"] == 50000
    assert result["late_over_30s"] == 1


def test_tick_recovery_seeds_fresh_baseline_and_does_not_invent_gap_crossing(running):
    db_factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.storage import MarketDataset

    with db_factory.begin() as db:
        instrument = db.get(MarketDataset, identity.key).instrument_id
        watch = create_watch(db, instrument, "tick", {"kind": "price", "timeframe": "tick",
            "direction": "buy", "level": "1.25"}, armed_at=0)
        watch.state = {"quote": "1.00", "quote_at": 1000}
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch, source=126000, bid="1.30"), identities, now=126000)
    with db_factory.begin() as db:
        assert db.scalar(select(SignalRow)) is None
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=2, source=127000, bid="1.20"), identities, now=127000)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=3, source=128000, bid="1.30"), identities, now=128000)
    with db_factory.begin() as db:
        signal = db.scalar(select(SignalRow))
        assert signal and signal.evidence["selection_epoch"] == epoch
        assert signal.evidence["dataset_identity"]["environment"] == "practice"
    # A duplicate event cannot create another signal/notification.
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=3, source=128000, bid="1.30"), identities, now=128000)
    with db_factory.begin() as db:
        assert len(db.scalars(select(SignalRow)).all()) == 1


def test_single_symbol_quote_gap_cannot_create_fake_crossing(running):
    db_factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.storage import MarketDataset

    with db_factory.begin() as db:
        instrument = db.get(MarketDataset, identity.key).instrument_id
        create_watch(db, instrument, "tick", {"kind": "price", "timeframe": "tick",
            "direction": "buy", "level": "1.25"}, armed_at=0)
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch, source=126000, bid="1.10"), identities, now=126000)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=2, source=150000, bid="1.30"), identities, now=150000)
    with db_factory.begin() as db:
        assert db.scalar(select(SignalRow)) is None


def test_invalid_spread_breaks_tick_judgment_continuity(running):
    from alerts.storage import MarketDataset

    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    with factory.begin() as db:
        instrument = db.get(MarketDataset, identity.key).instrument_id
        create_watch(db, instrument, "invalid spread continuity", {"kind": "price", "timeframe": "tick",
            "direction": "buy", "level": "1.25"}, armed_at=0)
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch, source=126000, bid="1.10"),
                       identities, now=126000)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=2, source=127000,
                       bid="1.15", ask="1.00"), identities, now=127000)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=3, source=128000, bid="1.30"),
                       identities, now=128000)
    with factory.begin() as db:
        assert db.scalar(select(SignalRow)) is None


def test_rest_close_samples_cross_only_between_observed_closes(running):
    factory, _, _, identities = running
    identity = identities["EUR_USD"]
    from alerts.service import evaluate_close_sample
    from alerts.storage import Instrument, MarketDataset

    with factory.begin() as db:
        dataset = db.get(MarketDataset, identity.key)
        instrument = db.get(Instrument, dataset.instrument_id)
        create_watch(db, instrument.id, "sampled close", {
            "kind": "price", "timeframe": "tick", "direction": "buy", "level": "1.25"},
            armed_at=0)
        evaluate_close_sample(db, instrument, 125000, "1.10", received_at=125000,
                              sequence=1, source_identity=identity.model_dump())
        evaluate_close_sample(db, instrument, 127000, "1.30", received_at=127000,
                              sequence=2, source_identity=identity.model_dump(), interval_ms=2000)
    with factory.begin() as db:
        signal = db.scalar(select(SignalRow))
        assert signal and signal.evidence["observation_mode"] == "candle_close_sample"
        assert signal.evidence["observation_gap_ms"] == 2000
        assert signal.evidence["source_identity"]["provider_symbol"] == "EUR_USD"


def test_rest_batch_fences_complete_before_forming_and_reports_candle_readiness(running):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.oanda_rest_batch import CandleSpec, normalize_latest

    payload = {"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1",
        "candles": [
            {"time": "60", "complete": True, "volume": 9,
             "bid": {"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.11"}},
            {"time": "120", "complete": False, "volume": 3,
             "bid": {"o": "1.11", "h": "1.13", "l": "1.10", "c": "1.12"}},
        ]}]}
    batch = normalize_latest(payload, [CandleSpec.from_dataset(identity)], generation=epoch,
                             sequence=1, demand_revision=live_demand_revision(
                                 [CandleSpec.from_dataset(identity)]), requested_at=124900,
                             received_at=125000)
    assert live.publish_rest_batch(ownership, epoch, batch, {"EUR_USD": identity}, now=125000) == "accepted"
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert state.ready and state.forming["acquisition_mode"] == "rest_batch"
        assert state.forming["close"] == "1.12"
        assert db.scalar(select(Bar).where(Bar.start == 60000)).complete
    view = next(row for row in live.snapshots(now=125000) if row["dataset_id"] == identity.key)
    assert view["observation_mode"] == "candle_close_sample"
    assert view["candle_ready"] and not view["quote_ready"]


def test_rest_forming_sample_during_recovery_does_not_advance_tick_baseline(running, monkeypatch):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.oanda_rest_batch import CandleSpec, normalize_latest

    calls = []
    # Keep the source in recovery so the forming candle is display-only.
    monkeypatch.setattr(live, "commit_confirmation", lambda *args, **kwargs: None)
    monkeypatch.setattr("alerts.service.evaluate_close_sample", lambda *args, **kwargs: calls.append(args))
    payload = {"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1",
        "candles": [{"time": "120", "complete": False, "volume": 3,
                      "bid": {"o": "1.11", "h": "1.13", "l": "1.10", "c": "1.12"}}]}]}
    batch = normalize_latest(payload, [CandleSpec.from_dataset(identity)], generation=epoch,
                             sequence=1, demand_revision=live_demand_revision(
                                 [CandleSpec.from_dataset(identity)]), requested_at=124900,
                             received_at=125000)
    assert live.publish_rest_batch(ownership, epoch, batch, {"EUR_USD": identity}, now=125000) == "accepted"
    assert not calls
    with factory.begin() as db:
        assert not db.get(LiveState, identity.key).ready


def test_rest_batch_demand_revision_fences_inflight_response_before_any_write(running):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.oanda_rest_batch import CandleSpec, normalize_latest

    batch = normalize_latest({"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1",
        "candles": [{"time": "120", "complete": False, "volume": 3,
                      "bid": {"o": "1.11", "h": "1.13", "l": "1.10", "c": "1.12"}}]}]},
        [CandleSpec.from_dataset(identity)], generation=epoch, sequence=1,
        demand_revision=live_demand_revision([CandleSpec.from_dataset(identity)]),
        requested_at=124900, received_at=125000)
    with pytest.raises(TimeoutError, match="demand"):
        live.publish_rest_batch(ownership, epoch,
            batch.model_copy(update={"demand_revision": "superseded-demand"}), identities, now=125000)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert state.forming == {} and state.received_at == 0
        assert db.scalar(select(Bar)) is None


def test_rest_batch_repeated_complete_head_skips_confirmation_rewrite(running, monkeypatch):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.oanda_rest_batch import CandleSpec, normalize_latest

    def make(received, sequence):
        return normalize_latest({"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1",
            "candles": [
                {"time": "60", "complete": True, "volume": 9,
                 "bid": {"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.11"}},
                {"time": "120", "complete": False, "volume": 3,
                 "bid": {"o": "1.11", "h": "1.13", "l": "1.10", "c": "1.12"}},
            ]}]}, [CandleSpec.from_dataset(identity)], generation=epoch, sequence=sequence,
            demand_revision=live_demand_revision([CandleSpec.from_dataset(identity)]),
            requested_at=received - 100, received_at=received)

    first = make(125000, 1)
    assert live.publish_rest_batch(ownership, epoch, first, {"EUR_USD": identity}, now=125000) == "accepted"
    calls = []
    monkeypatch.setattr(live, "commit_confirmation", lambda *args, **kwargs: calls.append(args))
    second = make(127000, 2)
    assert live.publish_rest_batch(ownership, epoch, second, {"EUR_USD": identity}, now=127000) == "accepted"
    assert not calls
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert state.confirmed_end == 120000 and state.forming["sequence"] == 2


def test_unauthorized_holds_configuration_fault_without_reconnect_storm(running):
    db_factory, ownership, epoch, identities = running
    live.disconnected(ownership, epoch, identities, RequestResult(status="unauthorized"), now=125000)
    assert live.claim("test-account", now=999999) is None
    with db_factory.begin() as db:
        assert db.get(PricingOwner, ownership[0]).error == "unauthorized"
    assert all(row["quality"] == "unauthorized" and not row["fallback_ready"]
               for row in live.snapshots(now=125000))


def test_account_scope_is_opaque():
    assert live.account_key("private-account") == hashlib.sha256(b"oanda:practice:private-account").hexdigest()


def test_missing_quote_side_or_crossed_spread_cannot_report_tick_ready(running):
    _, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    for seq, ask in ((1, None), (2, "1.00")):
        live.publish_event(ownership, epoch, quote(identity, epoch, seq=seq, ask=ask), identities, now=125000)
        state = next(row for row in live.snapshots(now=125000) if row["dataset_id"] == identity.key)
        assert not state["quote_ready"] and state["quality"] == "degraded"


def test_indicator_recovery_reports_insufficient_warmup_and_keeps_normal_confirmation_state(running, monkeypatch):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from alerts.storage import MarketDataset

    with factory.begin() as db:
        instrument = db.get(MarketDataset, identity.key).instrument_id
        watch = create_watch(db, instrument, "SMA", {"kind": "indicator", "timeframe": "M1",
            "indicator": "sma_cross", "indicator_version": "1",
            "indicator_params": {"fast": 2, "slow": 3}}, armed_at=0)
        ident = watch.id
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with factory.begin() as db:
        watch = db.get(Watch, ident)
        assert watch.paused_reason == "指标同源预热数据不足"
        assert len(watch.state["indicator_closes"]) == 2
    assert live.renew(ownership, now=150000)
    assert live.renew(ownership, now=175000)
    monkeypatch.setattr("alerts.service.now_ms", lambda: 185000)
    next_batch = candles(identity, window_start=60000, window_end=180000,
        observed_at=185000, rows=(minute(60000, volume="4"), minute(120000, volume="4")), checkpoint=180000)
    live.commit_confirmation(ownership, epoch, next_batch, now=185000)
    with factory.begin() as db:
        watch = db.get(Watch, ident)
        assert watch.state["last_event"] == 180000
        assert len(watch.state["indicator_closes"]) == 3
        assert watch.state["indicator_reading"] is not None
        assert watch.paused_reason is None
        assert db.scalar(select(SignalRow)) is None
