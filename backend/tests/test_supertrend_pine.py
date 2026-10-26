"""Source-rule fixtures plus framework/state/lifecycle contracts."""

import hashlib
import json
from pathlib import Path

import pytest
from alerts import chart_indicators as catalog
from alerts.indicator_state import ALGORITHM, IndicatorState
from alerts.supertrend_pine import NAME, OUTPUTS, SOURCES
from test_indicator_state import prices

FIXTURE = json.loads((Path(__file__).parent / "fixtures/supertrend_pine_v1.json").read_text())


def rows(ohlc):
    return [dict(zip(("open", "high", "low", "close"), values),
                 start=i * 60000, end=(i + 1) * 60000, complete=True)
            for i, values in enumerate(ohlc)]


def spec(**params):
    return {"name": NAME, "params": params}


def columns(result):
    return {series["key"]: [row["value"] for row in series["values"]]
            for series in result["series"]}


@pytest.mark.parametrize("method", ["wilder", "sma"])
def test_frozen_source_fixture_and_signal_anchor(method):
    source = rows(FIXTURE["ohlc"])
    config = spec(**FIXTURE["params"], atr_method=method)
    actual = columns(catalog.calculate(source, config))
    assert list(actual) == list(OUTPUTS)
    assert actual == {key: FIXTURE[method][key] for key in OUTPUTS}
    state = IndicatorState(config)
    for index, row in enumerate(source):
        assert state.step(row) == {key: FIXTURE[method][key][index] for key in OUTPUTS}
        assert state.state["atr"] == FIXTURE[method]["atr"][index]
    # The Buy threshold is previous D=10.5/11, but the plotted anchor is U=9.25/9.5.
    assert actual["buy_price"][-1] < 10


def test_reference_bytes_have_frozen_provenance():
    reference = Path(__file__).parents[2] / "docs/references/supertrend-pine-v4-20261012.pine"
    assert hashlib.sha256(reference.read_bytes()).hexdigest() == FIXTURE["reference_sha256"]


@pytest.mark.parametrize("method,first", [("wilder", 9), ("sma", 10)])
@pytest.mark.parametrize("count", [0, 1, 9, 10, 11])
def test_default_seed_and_no_startup_buy(count, method, first):
    result = columns(catalog.calculate(rows([[10, 11, 9, 10]] * count), spec(atr_method=method)))
    assert result["up"] == [None] * min(count, first) + [4.0] * max(0, count - first)
    assert result["direction"] == [1] * count
    assert result["buy_price"] == result["sell_price"] == [None] * count


@pytest.mark.parametrize("method,up,down,buy", [
    ("wilder", [5.7, 6.73], 17.043, 7.2613),
    ("sma", [None, 6.7], 17.1, 7.0),
])
def test_default_ten_hl2_three_atr_boundaries_direction_and_events(method, up, down, buy):
    source = rows([[10, 11, 9, 10]] * 9 + [
        [10, 13, 11, 12], [12, 14, 12, 13], [13, 13, 5, 5], [18, 20, 18, 19]])
    result = columns(catalog.calculate(source, spec(atr_method=method)))
    assert result["up"][:9] == [None] * 9
    assert result["up"][9:11] == pytest.approx(up)
    assert result["down"][-2:] == pytest.approx([down, None])
    assert result["sell_price"] == pytest.approx([None] * 11 + [down, None])
    assert result["buy_price"] == pytest.approx([None] * 12 + [buy])
    assert result["direction"] == [1] * 11 + [-1, 1]
    assert result["fill_reference"][-4:] == [11.5, 12.75, 9, 18.75]
    assert result["buy_price"][-1] != round(result["buy_price"][-1], 2) or method == "sma"


@pytest.mark.parametrize("method,expected", [("wilder", [8, 9]), ("sma", [None, 9])])
def test_period_one_keeps_atr_tr_first_bar_difference(method, expected):
    result = columns(catalog.calculate(rows(FIXTURE["ohlc"][:2]),
                                      spec(period=1, multiplier=1, atr_method=method)))
    assert result["up"] == expected


def test_equal_boundary_does_not_flip_and_flip_compares_previous_not_new_boundary():
    source = rows([[10, 11, 9, 10], [10, 12, 10, 11], [10, 11, 9, 9],
                   [9, 10, 8, 8.5], [10, 12, 10, 11], [11, 13, 11, 12]])
    state = IndicatorState(spec(period=2, multiplier=1))
    outputs = [state.step(row) for row in source]
    assert outputs[2]["direction"] == 1  # close == previous U == 9
    assert outputs[3]["direction"] == -1  # close 8.5 > new U=7, < previous U=9
    assert outputs[3]["sell_price"] == 11
    assert outputs[4]["direction"] == -1  # close == previous D == 11
    assert outputs[5]["direction"] == 1


@pytest.mark.parametrize("source,price", [
    ("open", 9.25), ("high", 11), ("low", 9), ("close", 10),
    ("hl2", 10), ("hlc3", 10), ("ohlc4", 9.8125),
])
def test_all_sources_keep_ohlc4_reference_independent(source, price):
    config = spec(period=1, multiplier=0.1, source=source)
    state = IndicatorState(config)
    result = state.step(rows([[9.25, 11, 9, 10]])[0])
    assert state.state["up"] == pytest.approx(price - 0.2)
    assert result["fill_reference"] == 9.8125
    assert result["buy_price"] is None and result["sell_price"] is None


@pytest.mark.parametrize("params", [
    {"period": True}, {"period": 0}, {"period": 501}, {"period": 1.1},
    {"source": "volume"}, {"source": 0}, {"source": None}, {"source": []},
    {"atr_method": "ema"}, {"atr_method": True},
    {"multiplier": 0}, {"multiplier": 100.1}, {"multiplier": float("nan")},
    {"multiplier": float("inf")}, {"showsignals": False}, {"highlighting": False},
])
def test_invalid_calculation_parameters_and_display_inputs_rejected(params):
    with pytest.raises(ValueError):
        catalog.validate(spec(**params))


@pytest.mark.parametrize("period,multiplier", [(1, 0.1), (500, 100)])
def test_valid_parameter_extremes(period, multiplier):
    assert catalog.validate(spec(period=period, multiplier=multiplier))[1]["period"] == period


def test_open_is_required_only_by_the_new_indicator():
    source = prices(4)
    assert catalog.calculate(source, {"name": "SMA", "params": {"period": 2}})
    with pytest.raises(ValueError, match=NAME + ".*open"):
        catalog.calculate(source, spec())
    with pytest.raises(ValueError, match=NAME + ".*open"):
        IndicatorState(spec()).step(source[0])


@pytest.mark.parametrize("method", ["wilder", "sma"])
@pytest.mark.parametrize("source", SOURCES)
def test_batch_checkpoint_pages_gap_and_provisional_match_from_fixed_origin(method, source):
    inputs = [row | {"open": row["close"] - 0.05} for row in prices(1200)]
    inputs[430]["gap_before"] = True
    inputs[780]["complete"] = False
    config = spec(period=13, multiplier=0.7, source=source, atr_method=method)
    expected = columns(catalog.calculate(inputs, config))
    state = IndicatorState(config)
    outputs = []
    for index, row in enumerate(inputs):
        if index % 137 == 0:
            state = IndicatorState(config, json.loads(json.dumps(state.checkpoint(), allow_nan=False)))
        outputs.append(state.step(row))
    for key in OUTPUTS:
        assert [row[key] for row in outputs] == pytest.approx(expected[key])
    original = state.checkpoint()
    next_bar = {**inputs[-1], "start": 1200 * 60000, "end": 1201 * 60000, "complete": False}
    for close in [inputs[-1]["close"] - 5, inputs[-1]["close"], inputs[-1]["close"] - 5]:
        trial = {**next_bar, "close": close, "low": min(close, next_bar["low"])}
        result = columns(catalog.calculate([*inputs, trial], config, provisional=True))
        assert state.step(trial, provisional=True) == pytest.approx({key: result[key][-1] for key in OUTPUTS})
        assert state.checkpoint() == original
    assert len(json.dumps(original)) < 3000


def test_intrabar_sell_retracts_and_reappears_without_advancing_state():
    state = IndicatorState(spec(period=2, multiplier=1))
    for row in rows(FIXTURE["ohlc"][:3]):
        state.step(row)
    checkpoint = state.checkpoint()
    row = rows(FIXTURE["ohlc"])[3] | {"complete": False}
    for close, expected in [(8, -1), (11, 1), (8, -1)]:
        actual = state.step(row | {"close": close}, provisional=True)
        assert actual["direction"] == expected
        assert (actual["sell_price"] is not None) == (expected == -1)
        assert state.checkpoint() == checkpoint


def test_gap_resets_and_weekend_without_gap_continues():
    source = rows(FIXTURE["ohlc"])
    config = spec(period=2, multiplier=1)
    state = IndicatorState(config)
    for row in source[:4]:
        state.step(row)
    weekend = source[4] | {"start": 4 * 86400000, "end": 4 * 86400000 + 60000}
    assert state.step(weekend)["direction"] == -1
    output = state.step(source[5] | {"gap_before": True})
    assert output["direction"] == 1 and output["buy_price"] is None and output["up"] is None


def test_period_one_gap_retains_numeric_value_and_declares_visual_break():
    source = rows([[10, 11, 9, 10], [10, 11, 9, 10], [10, 11, 9, 10]])
    source[1]["gap_before"] = True
    result = catalog.calculate(source, spec(period=1, multiplier=1))
    assert columns(result)["up"] == [8, 8, 8]
    assert result["series"][0]["values"][1]["break_before"] is True
    assert "break_before" not in result["series"][0]["values"][2]


def test_new_algorithm_does_not_invalidate_old_checkpoints_and_sparse_outputs_initialize():
    assert IndicatorState({"name": "EMA"}).algorithm == ALGORITHM
    state = IndicatorState(spec(period=1))
    assert state.algorithm != ALGORITHM
    values = state.step(rows([[10, 11, 9, 10]])[0])
    assert state.initialized(values) and values["buy_price"] is None
    checkpoint = state.checkpoint()
    checkpoint["algorithm"] = ALGORITHM
    with pytest.raises(ValueError, match="不匹配"):
        IndicatorState(spec(period=1), checkpoint)


def test_catalog_public_profile_and_enum_contract():
    meta = catalog.public_catalog()[NAME]
    assert meta["source"] == "Python" and meta["render_profile"] == "supertrend_pine_v1"
    assert meta["display_inputs"] == {"showsignals": True, "highlighting": True}
    assert meta["parameter_schema"]["source"]["options"] == list(SOURCES)
    json.dumps(meta, allow_nan=False)


def test_authenticated_catalogs_keep_native_profiles_out_of_legacy_workspace(database):
    from alerts import api
    from fastapi.testclient import TestClient

    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            legacy = client.get("/api/charts/catalog")
            advanced = client.get("/api/advanced-charts/catalog")
            assert legacy.status_code == advanced.status_code == 200
            legacy_indicators = legacy.json()["indicators"]
            assert NAME not in legacy_indicators
            assert "SWING_SR_V1" not in legacy_indicators
            assert set(legacy_indicators) == {
                "SMA", "EMA", "LWMA", "BBANDS", "RSI", "MACD", "ATR", "STOCH",
            }
            assert all("render_profile" not in meta for meta in legacy_indicators.values())
            assert advanced.json()[NAME]["render_profile"] == "supertrend_pine_v1"
            assert advanced.json()["SWING_SR_V1"]["render_profile"] == "swing_sr_v1"
            assert "history_requirement" not in advanced.json()[NAME]
    finally:
        api.app.dependency_overrides.clear()


def test_shared_plot_calculations_do_not_repeat_core_and_revision_invalidates(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from alerts import supertrend_pine as core

    source = rows(FIXTURE["ohlc"])
    config = spec(period=2, multiplier=1)
    calls = []
    original = core._calculate
    monkeypatch.setattr(core, "_CACHE", core.OrderedDict())
    def record(*args):
        calls.append(1)
        return original(*args)
    monkeypatch.setattr(core, "_calculate", record)
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(lambda _: columns(catalog.calculate(source, config)), range(5)))
    assert len(calls) == 1 and all(result == results[0] for result in results)
    changed = [*source[:-1], source[-1] | {"open": 13.1}]
    assert columns(catalog.calculate(changed, config))["fill_reference"][-1] != results[0]["fill_reference"][-1]
    assert len(calls) == 2
    catalog.calculate(source[1:], config)
    catalog.calculate(source, spec(period=2, multiplier=1, source="open"))
    assert len(calls) == 4


@pytest.mark.parametrize("method", ["wilder", "sma"])
def test_native_provider_page_reads_fixed_prefix_revises_and_matches_batch(database, monkeypatch, method):
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts.chart_query import DataQuery
    from test_provider_cache import META, seed

    monkeypatch.setattr(upstream, "metadata", lambda instrument: META)
    monkeypatch.setattr(cache, "now_ms", lambda: 10000000)
    source = rows(FIXTURE["ohlc"] * 20)
    for row in source:
        row["chart_time"] = row["start"]
    seed(META, "M1", source[-1]["end"], {"bars": source, "history_boundary": True})
    config = spec(period=2, multiplier=1, atr_method=method)
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1",
        before=source[-1]["end"], limit=20, indicators=[config])
    page = cache.data(query)
    for key, values in columns(page["indicators"][0]).items():
        assert values == pytest.approx(columns(catalog.calculate(source, config))[key][-20:])
    origin = source[0]["start"]
    older = cache.data(query.model_copy(update={"before": source[-10]["start"], "calculation_origin": origin}))
    for key, values in columns(older["indicators"][0]).items():
        assert values == pytest.approx(columns(catalog.calculate(source, config))[key][-30:-10])
    source[40] = source[40] | {"close": 8, "low": 8}
    seed(META, "M1", source[40]["end"], {"bars": [source[40]], "history_boundary": False})
    revised = cache.data(query)
    assert revised["cache_revision"] > page["cache_revision"]
    for key, values in columns(revised["indicators"][0]).items():
        assert values == pytest.approx(columns(catalog.calculate(source, config))[key][-20:])


@pytest.mark.parametrize("method", ["wilder", "sma"])
def test_fixed_jobs_restore_checkpoint_share_specs_and_keep_pagination_stable(database, monkeypatch, method):
    from alerts import fixed_indicators as jobs
    from alerts.chart_query import DataQuery, data_sync
    from alerts.history_artifacts import read_artifact
    from alerts.storage import FixedIndicatorBlock, FixedIndicatorRun
    from sqlalchemy import select
    from test_fixed_indicators import drain, history

    version = history(database, monkeypatch, count=2107)
    config = spec(period=13, multiplier=0.1, source="ohlc4", atr_method=method)
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=20,
                      indicators=[config, config | {"id": "second"}])
    pending = data_sync(query)
    ident = pending["indicator_progress"][0]["run_id"]
    assert ident == pending["indicator_progress"][1]["run_id"]
    owner = jobs.claim(ident)
    result = jobs.build(owner)
    assert len(result["rows"]) == jobs.PAGE_SIZE and not result["done"]
    assert result["rows"][0]["initialized"] is False
    assert result["rows"][-1]["initialized"] is True
    jobs.commit(owner, result)
    drain(ident)
    with database.begin() as db:
        source = read_artifact(db, version, "M1", limit=10000)
        assert db.get(FixedIndicatorRun, ident).algorithm == "supertrend-pine-state-v1"
        assert len(list(db.scalars(select(FixedIndicatorBlock)))) == 2
    expected = columns(catalog.calculate(source, config))
    ready = data_sync(query)
    assert not ready["pending"]
    assert all(row["initialized"] for row in ready["indicators"][0]["dependencies"])
    for key, values in columns(ready["indicators"][0]).items():
        assert values == pytest.approx(expected[key][-20:])
    older = data_sync(query.model_copy(update={"before": source[-10]["start"]}))
    assert older["indicator_progress"][0]["run_id"] == ident
    for key, values in columns(older["indicators"][0]).items():
        assert values == pytest.approx(expected[key][-30:-10])
