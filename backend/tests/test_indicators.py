from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from alerts.domain import Candle, Rule, State, advance
from alerts.service import add_replay_watch, create_watch, evaluate_watch, replay_step
from alerts.storage import Bar, Replay, candle_dict, ms, state_dict, state_from
from sqlalchemy import select

START = datetime(2026, 1, 5, tzinfo=UTC)


def candles(prices):
    return [
        Candle(
            START + timedelta(minutes=i),
            START + timedelta(minutes=i + 1),
            *(Decimal(str(p)) for _ in range(4)),
        )
        for i, p in enumerate(prices)
    ]


def rule(**kwargs):
    return Rule("indicator", timeframe="M1", indicator_params={"fast": 2, "slow": 3}, **kwargs)


@pytest.mark.parametrize(
    "prices,direction", [([3, 2, 1, 3, 5], "buy"), ([1, 2, 3, 1, 0.5], "sell")]
)
def test_cross_after_warmup_and_restart(prices, direction):
    state = State()
    bars = candles(prices)
    for b in bars[:3]:
        assert advance(rule(), state, b, armed_at=START) is None
    state = state_from(state_dict(state))
    # Equal averages on the fourth bar do not cross. The next closes beyond.
    results = [advance(rule(), state, b, armed_at=START) for b in bars[3:]]
    assert results[0] is None
    signals = [s for s in results if s]
    assert len(signals) == 1 and signals[0].direction == direction
    assert len(state.indicator_closes) == 3
    assert signals[0].evidence["indicator_params"] == {"fast": 2, "slow": 3}
    assert signals[0].evidence["indicator_current"] != signals[0].evidence["indicator_previous"]


def test_historical_cross_is_consumed_and_direction_filter():
    bars = candles([3, 2, 1, 3, 5, 6])
    state = State()
    for b in bars[:-1]:
        assert advance(rule(), state, b) is None
    assert advance(rule(), state, bars[-1], armed_at=bars[-2].end) is None
    state = State()
    assert all(advance(rule(direction="sell"), state, b, armed_at=START) is None for b in bars)


def test_indicator_rejects_incomplete_without_consuming_state():
    state = State()
    with pytest.raises(ValueError, match="incomplete"):
        advance(rule(), state, replace(candles([1])[0], complete=False))
    assert state == State()


@pytest.mark.parametrize(
    "params", [{"fast": 3, "slow": 3}, {"fast": True}, {"slow": 501}, {"other": 2}]
)
def test_invalid_parameters(params):
    with pytest.raises(ValueError):
        Rule("indicator", indicator_params=params)


def test_unknown_plugin_and_version_rejected():
    with pytest.raises(ValueError):
        Rule("indicator", indicator="missing")
    with pytest.raises(ValueError):
        Rule("indicator", indicator_version="2")


def test_live_replay_equivalence_and_no_history(database):
    bars = candles([3, 2, 1, 3, 5])
    config = {"kind": "indicator", "timeframe": "M1", "indicator_params": {"fast": 2, "slow": 3}}
    with database.begin() as db:
        for b in bars:
            db.add(
                Bar(
                    instrument_id="BTCUSDT",
                    timeframe="M1",
                    start=ms(b.start),
                    end=ms(b.end),
                    open=b.open,
                    high=b.high,
                    low=b.low,
                    close=b.close,
                    complete=True,
                )
            )
        db.flush()
        watch = create_watch(db, "BTCUSDT", "SMA", config, armed_at=ms(bars[2].end))
        ident = watch.id
        assert watch.rule["indicator_version"] == "1"
    # Different DB session proves indicator state survives persistence.
    with database.begin() as db:
        live = evaluate_watch(db, ident)
        assert live is not None
        stored_bars = db.scalars(select(Bar).order_by(Bar.start)).all()
        run = Replay(
            instrument_id="BTCUSDT",
            timeframe="M1",
            start=ms(bars[2].end),
            end=ms(bars[-1].end),
            cursor=ms(bars[2].end),
            bars=[candle_dict(b.candle()) for b in stored_bars],
            days=[],
            watches=[],
            signals=[],
        )
        add_replay_watch(run, "SMA", config, "utc0")
        add_replay_watch(run, "no warmup", config, "utc0", use_history=False)
        assert run.watches[1]["state"]["indicator_closes"] == []
        replay_step(run, "utc0", 2)
        assert len(run.signals) == 1
        signal = run.signals[0]
        assert signal["occurred_at"] == live.occurred_at
        assert Decimal(signal["price"]) == live.price
        assert signal["evidence"] == {
            k: v for k, v in live.evidence.items() if k not in {"source", "basis", "rule"}
        }
