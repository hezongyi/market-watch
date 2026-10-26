"""V1 acceptance against frozen OANDA evidence and causal checkpoint behavior."""

import copy
import json
from pathlib import Path

import pytest
from alerts.chart_indicators import (
    calculate,
    history_requirement,
    public_catalog,
    validate,
    validate_display,
)
from alerts.indicator_state import IndicatorState

EVIDENCE = Path(__file__).parents[2] / "docs/research/patternsmart-evidence-20261012"
SPEC = {"name": "SWING_SR_V1"}


def records(name):
    return [json.loads(line) for line in (EVIDENCE / name).read_text().splitlines()]


def recent():
    return [row for row in records("snapshot.jsonl") if row["kind"] == "managed_bar"]


def long_rows():
    native = [
        row["payload"] for row in records("long_snapshot.jsonl") if row["kind"] == "provider_bar"
    ]
    return native + [row for row in recent() if row["start"] > native[-1]["start"]]


def values(result, key):
    return [
        item["value"] for item in next(s for s in result["series"] if s["key"] == key)["values"]
    ]


def test_recent_visible_positions_endpoints_preview_and_confirmation():
    rows = recent()
    result = calculate(rows, SPEC, provisional=True)
    p = result["presentation"]
    assert len(rows) == 175
    assert p["current"]["high"] == {
        "price": 1.12420,
        "pivot_time": rows[169]["start"],
        "detected_bar_time": rows[174]["start"],
        "confirmed_at": None,
        "provisional": True,
    }
    assert p["current"]["low"]["pivot_time"] == rows[164]["start"]
    assert p["current"]["low"]["price"] == 1.11711
    report = json.loads((EVIDENCE / "analysis.json").read_text())
    # Screenshot evidence records six high and seven low visible segment starts.
    matches = report["matches"]
    assert len(matches) == 13
    for event in matches:
        side, index = event["side"], event["index"]
        assert values(result, side)[index + 5] == float(rows[index][side])
    highs = [event["index"] for event in matches if event["side"] == "high"]
    for old, new in zip(highs, highs[1:]):
        plot = values(result, "high")
        assert plot[new + 4] == float(rows[old]["high"])
        assert plot[new + 5] == float(rows[new]["high"])
    confirmed = calculate(rows, SPEC)
    assert confirmed["presentation"]["current"]["high"]["pivot_time"] == rows[152]["start"]
    assert values(confirmed, "high")[173] == float(rows[152]["high"])
    assert values(confirmed, "high")[174] is None
    assert (
        calculate(rows[:-1], SPEC)["presentation"]["current"]["high"]["pivot_time"]
        == rows[152]["start"]
    )
    json.dumps(result, allow_nan=False)


def test_long_precise_statistics_and_preview_rollback():
    rows = long_rows()
    original = copy.deepcopy(rows)
    result = calculate(rows, SPEC, provisional=True)
    assert len(rows) == 4002
    for side, events, total, count, integer in [
        ("high", 264, 3989, 263, 15),
        ("low", 249, 3978, 248, 16),
    ]:
        item = result["presentation"]["statistics"][side]
        assert (
            item["event_count"],
            item["interval_sum"],
            item["interval_count"],
            item["display_integer"],
        ) == (events, total, count, integer)
        assert item["mean"] == pytest.approx(total / count, abs=1e-12)
    rejected = [*rows[:-1], {**rows[-1], "high": 1.125}]
    withdrawn = calculate(rejected, SPEC, provisional=True)
    baseline = calculate(rows[:-1], SPEC)
    assert (
        withdrawn["presentation"]["current"]["high"] == baseline["presentation"]["current"]["high"]
    )
    assert (
        withdrawn["presentation"]["statistics"]["high"]
        == baseline["presentation"]["statistics"]["high"]
    )
    assert calculate(rows, SPEC, provisional=True) == result
    assert rows == original
    closed = calculate([*rows[:-1], {**rows[-1], "complete": True}], SPEC)
    assert closed["presentation"]["current"]["high"]["confirmed_at"] == rows[-1]["end"]


def test_frozen_calendar_declares_holidays_but_preserves_unknown_gaps():
    from datetime import UTC, datetime

    from alerts.chart_calculation_history import calculation_rows

    rows = long_rows()
    profile = json.loads((EVIDENCE / "swing-acceptance-calendar.json").read_text())
    mapped = calculation_rows(rows, {"calendar": "ny17", "calendar_profile": profile}, "EURUSD")
    assert not any(row.get("gap_before") for row in mapped)
    assert calculate(mapped, SPEC, provisional=True) == calculate(rows, SPEC, provisional=True)
    unknown = calculation_rows(rows, {"calendar": "ny17"}, "EURUSD")
    assert sum(bool(row.get("gap_before")) for row in unknown) == 4
    conservative = calculate(unknown, SPEC, provisional=True)["presentation"]["statistics"]
    assert conservative["high"]["event_count"] == 261
    assert conservative["low"]["event_count"] == 246
    # Removing a Wednesday candle outside the holiday policy remains missing data.
    index = next(i for i in range(100, 500) if
                 datetime.fromtimestamp(rows[i]["start"] / 1000, UTC).weekday() == 2)
    missing = [*rows[:index], *rows[index + 1:]]
    mapped = calculation_rows(missing, {"calendar": "ny17", "calendar_profile": profile}, "EURUSD")
    assert mapped[index]["gap_before"] is True


@pytest.mark.parametrize(
    "params",
    [
        {"high_strength": 5, "low_strength": 5},
        {"high_strength": 1, "low_strength": 3},
        {"high_strength": 17, "low_strength": 8},
        {"high_strength": 500, "low_strength": 1},
    ],
)
def test_checkpoints_batches_gaps_and_ticks_match_full_range(params):
    rows = long_rows()
    rows[800]["gap_before"] = True
    rows[1300]["complete"] = False
    spec = {"name": "SWING_SR_V1", "params": params}
    expected = calculate(rows, spec, provisional=True)
    engine = IndicatorState(spec)
    output = []
    for index, row in enumerate(rows):
        if index % 137 == 0:
            engine = IndicatorState(
                spec, json.loads(json.dumps(engine.checkpoint(), allow_nan=False))
            )
        before = engine.checkpoint()
        preview = index == len(rows) - 1
        output.append(engine.step(row, provisional=preview))
        if preview:
            assert engine.checkpoint() == before
    for key in ("high", "high_left", "low", "low_left"):
        assert [item[key] for item in output] == values(expected, key)
    assert engine.last_presentation == expected["presentation"]


def synthetic(highs, lows=None):
    return [
        {
            "start": i * 60000,
            "end": (i + 1) * 60000,
            "high": high,
            "low": low,
            "close": 2,
            "complete": True,
        }
        for i, (high, low) in enumerate(zip(highs, lows or [1] * len(highs)))
    ]


def test_ties_same_price_events_and_segment_spacing():
    spec = {"name": "SWING_SR_V1", "params": {"high_strength": 1, "low_strength": 1}}
    assert (
        calculate(synthetic([2, 3, 3, 2]), spec)["presentation"]["statistics"]["high"][
            "event_count"
        ]
        == 0
    )
    rows = synthetic([2, 4, 2, 4, 2, 4, 2], [1, 0, 1, 0, 1, 0, 1])
    result = calculate(rows, spec)
    assert result["presentation"]["current"]["high"]["pivot_time"] == rows[5]["start"]
    assert result["presentation"]["statistics"]["high"]["interval_sum"] == 4
    assert result["presentation"]["statistics"]["high"]["event_count"] == 3
    rows[3]["gap_before"] = True
    result = calculate(rows, spec)
    assert result["presentation"]["statistics"]["high"]["event_count"] == 2
    assert result["presentation"]["statistics"]["high"]["interval_count"] == 0
    assert values(result, "high")[3:5] == [None, None]


def test_detection_is_causal_and_round_half_up_is_exact():
    rows = synthetic([2, 5, 2, 2, 2, 5, 2])
    spec = {"name": "SWING_SR_V1", "params": {"high_strength": 1, "low_strength": 1}}
    for end in range(1, len(rows) + 1):
        result = calculate(rows[:end], spec)
        assert values(result, "high") == values(calculate(rows, spec), "high")[:end]
    from alerts.swing_sr import empty_statistics, statistics

    stats = empty_statistics()
    stats["high"].update(interval_sum=5, interval_count=2)
    assert statistics(stats)["high"]["display_integer"] == 3


def test_catalog_display_and_strength_contract():
    catalog = public_catalog()[SPEC["name"]]
    assert [item["key"] for item in catalog["series"]] == ["high", "high_left", "low", "low_left"]
    assert history_requirement(SPEC) == 10
    assert history_requirement(SPEC | {"params": {"high_strength": 9, "low_strength": 3}}) == 18
    assert validate_display(SPEC["name"], {})["statistics_position"] == "bottom_left"
    for bad in (
        {"hh_source": "close"},
        {"show_average_spacing": 1},
        {"statistics_position": "right"},
    ):
        with pytest.raises(ValueError):
            validate_display(SPEC["name"], bad)
        with pytest.raises(ValueError):
            validate(SPEC | {"display_inputs": bad})
    for value in (0, 501, True, 2.5):
        with pytest.raises(ValueError):
            validate(SPEC | {"params": {"high_strength": value}})
    json.dumps(catalog, allow_nan=False)


def test_fixed_history_job_presentation_is_full_origin_when_paging(database, monkeypatch):
    from alerts import fixed_indicators as jobs
    from alerts.chart_query import DataQuery, data_sync
    from test_fixed_indicators import drain, history

    version = history(database, monkeypatch)
    query = DataQuery(
        instrument=version, series_kind="history", timeframe="M1", limit=7, indicators=[SPEC]
    )
    pending = data_sync(query)
    assert pending["indicators"][0]["presentation"]["history_complete"] is False
    drain(pending["indicator_progress"][0]["run_id"])
    latest = data_sync(query)
    older = data_sync(query.model_copy(update={"before": latest["bars"][0]["start"]}))
    assert latest["indicators"][0]["presentation"] == older["indicators"][0]["presentation"]
    assert latest["indicators"][0]["presentation"]["statistics_origin"] == 0
    assert latest["indicators"][0]["presentation"]["history_complete"] is True
    assert len(jobs.IndicatorState(SPEC).checkpoint()["state"]) == 0


def test_provider_page_keeps_full_statistics_and_source_chart_labels(database, monkeypatch):
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts.chart_query import DataQuery
    from test_provider_cache import META, seed

    rows = synthetic([2, 4, 2, 5, 2, 4, 2, 5, 2, 4, 2, 5, 2])
    for row in rows:
        row["chart_time"] = row["start"] + 1234
        row["open"] = row["close"]
    seed(META, "M5", rows[-1]["end"], {"bars": rows, "history_boundary": True})
    monkeypatch.setattr(upstream, "metadata", lambda *_args, **_kwargs: META)
    monkeypatch.setattr(
        upstream, "native_page", lambda *_args, **_kwargs: pytest.fail("cache read only")
    )
    spec = SPEC | {"params": {"high_strength": 1, "low_strength": 1}}
    query = DataQuery(
        instrument=META["id"],
        series_kind="provider",
        timeframe="M5",
        before=rows[-1]["end"],
        limit=3,
        indicators=[spec],
    )
    latest = cache.data(query)
    older = cache.data(query.model_copy(update={"before": rows[6]["start"]}))
    assert latest["indicators"][0]["presentation"] == older["indicators"][0]["presentation"]
    assert len(older["bars"]) == 3

    assert older["bars"][-1]["start"] < latest["bars"][0]["start"]
    p = latest["indicators"][0]["presentation"]
    assert p["current"]["high"]["pivot_chart_time"] == rows[-2]["chart_time"]
    assert p["as_of_chart_time"] == rows[-1]["chart_time"]
    assert p["statistics"]["high"]["event_count"] == 6


def test_published_page_keeps_full_statistics(database):
    from alerts import managed_dataset
    from alerts.chart_query import DataQuery
    from alerts.storage import ChartPublication, ChartPublishedBar

    rows = synthetic([2, 4, 2, 5, 2, 4, 2, 5, 2, 4, 2, 5, 2])
    for row in rows:
        row["open"] = row["close"]
    with database.begin() as db:
        db.add(
            ChartPublication(
                instrument_id="BTCUSDT",
                timeframe="M1",
                start=0,
                end=rows[-1]["end"],
                complete_count=len(rows),
                initialized=True,
            )
        )
        for row in rows:
            db.add(
                ChartPublishedBar(
                    instrument_id="BTCUSDT",
                    timeframe="M1",
                    start=row["start"],
                    end=row["end"],
                    complete=True,
                    payload=row,
                )
            )
    spec = SPEC | {"params": {"high_strength": 1, "low_strength": 1}}
    query = DataQuery(
        instrument="BTCUSDT",
        published=True,
        timeframe="M1",
        before=rows[-1]["end"],
        limit=3,
        indicators=[spec],
    )
    latest = managed_dataset.data(query)
    older = managed_dataset.data(query.model_copy(update={"before": rows[6]["start"]}))
    assert latest["indicators"][0]["presentation"] == older["indicators"][0]["presentation"]
    assert len(older["bars"]) == 3

    # Swing computes from the full range even for an old viewport. Pagination
    # must still end at the requested prefix, including short and empty pages.
    assert latest["has_more"] is True
    for before, expected in [(180000, [0, 60000, 120000]), (60000, [0]), (1, [0])]:
        earliest = managed_dataset.data(query.model_copy(update={"before": before}))
        assert [row["start"] for row in earliest["bars"]] == expected
        assert earliest["has_more"] is False
        assert earliest["indicators"][0]["presentation"] == latest["indicators"][0]["presentation"]
    empty = managed_dataset.data(query.model_copy(update={"before": 1, "dataset_start": 60000}))
    assert empty["bars"] == []
    assert empty["has_more"] is False


def test_fixed_composite_preview_is_page_independent_and_never_persisted(database, monkeypatch):
    from alerts import fixed_indicators as jobs
    from alerts.composite_chart import chart_page
    from alerts.storage import FixedIndicatorRun
    from test_composite_chart import populated
    from test_fixed_indicators import aggregates, drain

    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M1")
    spec = SPEC | {"params": {"high_strength": 1, "low_strength": 1}}
    stamp = seam + 650000
    with database.begin() as db:
        page = chart_page(db, composite, "M1", now=stamp, count=20)
        ident = jobs.request(db, page, spec, stamp=stamp).id
    drain(ident)
    forming = {**page["bars"][-1], "start": seam + 600000, "end": seam + 660000,
               "complete": False, "high": "1.12", "low": "1.11"}
    page["bars"].append(forming)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        original = copy.deepcopy(run.state)
        latest, _ = jobs.chart_results(db, page, [spec], provisional=True, stamp=stamp)
        older_page = {**page, "bars": page["bars"][:2]}
        import alerts.composite_chart

        monkeypatch.setattr(alerts.composite_chart, "chart_page", lambda *_a, **_k: page)
        older, _ = jobs.chart_results(db, older_page, [spec], provisional=True, stamp=stamp)
        assert latest[0]["presentation"] == older[0]["presentation"]
        assert latest[0]["presentation"]["as_of_bar_time"] == forming["start"]
        assert run.state == original
        assert all(value["time"] < older_page["bars"][-1]["end"]
                   for series in older[0]["series"] for value in series["values"])
