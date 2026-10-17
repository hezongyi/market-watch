"""Published snapshots share exact computation without conflating new specs."""

import math

import pytest
from alerts.chart_api import DataQuery
from alerts.chart_calculation_history import calculation_rows
from alerts.chart_indicators import calculate
from alerts.managed_dataset import data
from alerts.storage import ChartPublication, ChartPublishedBar, Instrument
from sqlalchemy import select


def seed(database, count=2400):
    rows = []
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.calendar = "utc0"
        db.add(
            ChartPublication(
                instrument_id=inst.id,
                timeframe="M1",
                start=60000,
                end=(count + 1) * 60000,
                complete_count=count,
                revision=1,
                initialized=True,
            )
        )
        for i in range(count):
            price = 100 + math.sin(i / 7)
            row = dict(
                start=(i + 1) * 60000,
                end=(i + 2) * 60000,
                open=str(price),
                high=str(price + 2),
                low=str(price - 2),
                close=str(price + 1),
                complete=True,
            )
            db.add(
                ChartPublishedBar(
                    instrument_id=inst.id,
                    timeframe="M1",
                    start=row["start"],
                    end=row["end"],
                    payload=row,
                    complete=True,
                    revision=1,
                )
            )
            rows.append(row)
    return rows


def query(name="EMA", period=None):
    return DataQuery(
        instrument="BTCUSDT",
        series_kind="managed",
        timeframe="M1",
        published=True,
        before=200000000,
        limit=100,
        indicators=[{"name": name, "params": {"period": period} if period else {}}],
    )


@pytest.mark.parametrize(
    "name",
    [
        "SMA",
        "EMA",
        "LWMA",
        "BBANDS",
        "RSI",
        "MACD",
        "ATR",
        "STOCH",
        "SWING_SR_V1",
        "SUPERTREND_PINE_V1",
    ],
)
def test_every_catalog_item_matches_full_origin_and_shares_repeated_inputs(database, name):
    rows = seed(database)
    request = query(name)
    first = data(request)
    second = data(request)
    execution = second["indicators"][0]["calculation"]["execution"]
    assert execution["input_cache"] == "hit"
    assert execution["sql_payload_rows"] == 0
    assert execution["result_cache"] == "hit"
    assert execution["calculation_steps"] == 0
    assert execution["input_rows"] == 2400, "A result hit still declares its complete fixed prefix size"
    expected = calculate(
        calculation_rows(rows, {"calendar": "utc0"}, "BTCUSDT"), request.indicators[0]
    )
    for actual, target in zip(second["indicators"][0]["series"], expected["series"], strict=True):
        values = [v for v in target["values"] if v["time"] >= first["bars"][0]["start"]]
        for a, b in zip(actual["values"], values, strict=True):
            assert a["time"] == b["time"]
            assert a["value"] == pytest.approx(b["value"], abs=1e-8, rel=1e-10)


def test_new_spec_reuses_input_but_replays_its_own_origin(database):
    seed(database)
    data(query("EMA", 500))
    second = data(query("EMA", 499))["indicators"][0]["calculation"]["execution"]
    assert second["input_cache"] == "hit" and second["sql_payload_rows"] == 0
    assert second["result_cache"] == "miss" and second["calculation_steps"] == 2400


def test_append_resumes_checkpoint_and_earlier_correction_replays(database):
    rows = seed(database)
    request = query("EMA", 500)
    data(request)
    tail = {**rows[-1], "start": rows[-1]["end"], "end": rows[-1]["end"] + 60000, "close": "123"}
    with database.begin() as db:
        db.add(
            ChartPublishedBar(
                instrument_id="BTCUSDT",
                timeframe="M1",
                start=tail["start"],
                end=tail["end"],
                payload=tail,
                complete=True,
                revision=1,
            )
        )
        pub = db.get(ChartPublication, ("BTCUSDT", "M1"))
        pub.revision += 1
        pub.end = tail["end"]
    appended = data(request)
    execution = appended["indicators"][0]["calculation"]["execution"]
    assert execution["input_cache"] == "append" and execution["sql_payload_rows"] == 2
    assert execution["result_cache"] == "checkpoint" and execution["calculation_steps"] < 512
    with database.begin() as db:
        row = db.get(ChartPublishedBar, ("BTCUSDT", "M1", rows[100]["start"]))
        row.payload = {**row.payload, "close": "200"}
        row.revision += 1
        db.get(ChartPublication, ("BTCUSDT", "M1")).revision += 1
    repaired = data(request)
    execution = repaired["indicators"][0]["calculation"]["execution"]
    assert execution["input_cache"] == "miss" and execution["calculation_steps"] == 2401
    with database.begin() as db:
        expected_rows = list(
            db.scalars(
                select(ChartPublishedBar.payload)
                .where(ChartPublishedBar.instrument_id == "BTCUSDT")
                .order_by(ChartPublishedBar.start)
            )
        )
    expected = calculate(expected_rows, request.indicators[0])["series"][0]["values"][-100:]
    for actual, target in zip(
        repaired["indicators"][0]["series"][0]["values"], expected, strict=True
    ):
        assert actual["value"] == pytest.approx(target["value"], abs=1e-8, rel=1e-10)
