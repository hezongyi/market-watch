"""Transactional observation retention through the real collector interfaces."""

import pytest
from alerts import live_pricing
from alerts.chart_alert_service import current_version
from alerts.market_contracts import DatasetIdentity, RequestResult
from alerts.price_alert_inputs import is_price_rule, prune, read_after
from alerts.storage import ChartAlert, LiveState, PriceAlertInput, PriceAlertStream
from sqlalchemy import func, select
from test_composite_alerts import armed
from test_live_pricing import quote


@pytest.fixture
def collecting(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar")
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        identity = DatasetIdentity.model_validate(current_version(db, alert).market_identity["target_identity"])
        state = db.get(LiveState, identity.key)
        state.quote = {**state.quote, "sequence": 0, "received_at": stamp}
    ownership = (live_pricing.account_key(live_pricing.settings.oanda_account_id), "test-owner")
    return database, ident, identity, ownership, stamp


def publish(fixture, seq, price, *, at=None):
    _, _, identity, owner, stamp = fixture
    at = stamp + seq * 100 if at is None else at
    return live_pricing.publish_event(owner, 1,
        quote(identity, 1, seq=seq, source=at, received_at=at, bid=price),
        {"EUR_USD": identity}, now=at)


def test_same_millisecond_prices_have_distinct_sequences_and_replay_is_noop(collecting):
    factory, _, identity, _, stamp = collecting
    for seq, price in enumerate(("1.110", "1.120", "1.110"), 1):
        assert publish(collecting, seq, price, at=stamp + 100) == "accepted"
    assert publish(collecting, 3, "1.110", at=stamp + 100) == "rejected_sequence"
    with factory.begin() as db:
        rows = read_after(db, identity.key, 0)
        assert [r.price for r in rows] == ["1.110", "1.120", "1.110"]
        assert [r.sequence for r in rows] == [1, 2, 3]
        assert {r.occurred_at for r in rows} == {stamp + 100}
        assert db.get(LiveState, identity.key).quote["bid"] == "1.110"


def test_log_failure_rolls_back_latest_snapshot_and_sequence(collecting, monkeypatch):
    from alerts import price_alert_inputs

    factory, _, identity, _, _ = collecting
    publish(collecting, 1, "1.110")
    original = price_alert_inputs.record_quote

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("injected after append before commit")

    with monkeypatch.context() as patch:
        patch.setattr(price_alert_inputs, "record_quote", fail)
        with pytest.raises(RuntimeError, match="injected"):
            publish(collecting, 2, "1.120")
    with factory.begin() as db:
        assert db.get(LiveState, identity.key).quote["bid"] == "1.110"
        assert db.get(PriceAlertStream, identity.key).sequence == 1
    publish(collecting, 2, "1.120")
    with factory.begin() as db:
        assert [r.price for r in read_after(db, identity.key, 0)] == ["1.110", "1.120"]


def test_no_new_log_without_enabled_touch_demand(collecting):
    factory, ident, _, _, _ = collecting
    with factory.begin() as db:
        db.get(ChartAlert, ident).status = "paused"
    publish(collecting, 1, "1.110")
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(PriceAlertInput)) == 0


def test_retention_loss_boundary_survives_deletion_and_transaction_rollback(collecting):
    factory, _, identity, _, stamp = collecting
    for seq in range(1, 5):
        publish(collecting, seq, "1.110")
    with pytest.raises(RuntimeError):
        with factory.begin() as db:
            assert prune(db, identity.key, now=stamp + 500, max_rows=2) == 2
            raise RuntimeError("rollback retention")
    with factory.begin() as db:
        assert db.get(PriceAlertStream, identity.key).trimmed_through == 0
        assert len(read_after(db, identity.key, 0)) == 4
        assert prune(db, identity.key, now=stamp + 500, max_rows=2) == 2
    with factory.begin() as db:
        stream = db.get(PriceAlertStream, identity.key)
        assert stream.trimmed_through == 2
        assert (stream.trimmed_start, stream.trimmed_end) == (stamp + 100, stamp + 200)
        assert [r.sequence for r in read_after(db, identity.key, 0)] == [3, 4]


def test_disconnect_persists_marker_in_the_same_transaction(collecting):
    factory, _, identity, owner, stamp = collecting
    publish(collecting, 1, "1.110")
    live_pricing.disconnected(owner, 1, {"EUR_USD": identity},
        RequestResult(status="timeout"), now=stamp + 200)
    with factory.begin() as db:
        rows = read_after(db, identity.key, 0)
        assert [r.kind for r in rows] == ["price", "interruption"]
        assert rows[-1].evidence["reason_code"] == "timeout"
        assert db.get(LiveState, identity.key).connection == "disconnected"


def test_rest_samples_keep_receive_time_contract_and_mode_boundary(collecting):
    from alerts.oanda_rest_batch import CandleSpec, live_demand_revision, normalize_latest

    factory, _, identity, owner, stamp = collecting
    publish(collecting, 1, "1.110")
    spec = CandleSpec.from_dataset(identity)
    payload = {"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1", "candles": [
        {"time": str(stamp // 60000 * 60), "complete": False, "volume": 3,
         "bid": {"o": "1.11", "h": "1.13", "l": "1.10", "c": "1.12"}}]}]}
    batch = normalize_latest(payload, [spec], generation=1, sequence=2,
        demand_revision=live_demand_revision([spec]), requested_at=stamp + 200, received_at=stamp + 300)
    live_pricing.publish_rest_batch(owner, 1, batch, {"EUR_USD": identity}, now=stamp + 300)
    live_pricing.publish_rest_batch(owner, 1, batch, {"EUR_USD": identity}, now=stamp + 300)
    with factory.begin() as db:
        rows = read_after(db, identity.key, 0)
        assert [r.kind for r in rows] == ["price", "interruption", "price"]
        assert rows[1].evidence["reason_code"] == "observation_mode_changed"
        assert rows[-1].price == "1.12" and rows[-1].occurred_at == stamp + 300
        assert rows[-1].mode == "candle_close_sample"


@pytest.mark.parametrize("kind,expected", [("horizontal_line", True), ("horizontal_ray", False),
    ("trend_line", False), ("ray", False)])
def test_classifier_does_not_absorb_complex_rules(kind, expected):
    config = {"series_kind": "composite", "condition": {"left": {"kind": "price"},
        "right": {"kind": "line", "line": {"kind": kind}}, "relation": "cross"}}
    assert is_price_rule(config) is expected
    config["condition"]["offset"] = {"kind": "atr"}
    assert not is_price_rule(config)
