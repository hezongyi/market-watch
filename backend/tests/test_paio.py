"""Hand-calculated source-branch fixtures, NOT a TradingView runtime oracle."""

import copy
import json
import time

import pytest
from alerts.chart_indicators import calculate, public_catalog, validate
from alerts.indicator_state import IndicatorState
from alerts.paio import PaioState
from alerts.paio_spec import OUTPUTS


def bars(ranges, *, start=0, duration=60000):
    return [dict(start=start+i*duration, end=start+(i+1)*duration,
                 open=(low+high)/2, high=high, low=low, close=(low+high)/2,
                 complete=True, indicator_timeframe="M1", indicator_calendar="utc0")
            for i, (low, high) in enumerate(ranges)]


def run(rows, params=None):
    engine = PaioState(params)
    return engine, [engine.step(row) for row in rows]


def test_all_original_inputs_registered():
    import re
    from pathlib import Path

    source = (Path(__file__).parents[2]/"docs/references/paio-fengyangsi-v6-20261118.pine").read_text()
    declared = set(re.findall(r"^(\w+)\s*=\s*input\.", source, re.M))
    meta = public_catalog()["PAIO_V1"]
    registered = set(meta["params"]) | {item["id"] for item in meta["display_inputs"]}
    assert declared == registered
    assert len(meta["series"]) == 19
    assert tuple(item["key"] for item in meta["series"]) == OUTPUTS


@pytest.mark.parametrize("params", [{"ma_1_length": 0}, {"ma_2_timeframe": "2"},
                                   {"bi_specific": "x"*1025}, {"bi_specific": "1\n2"}, {"bi_use": 1}])
def test_reject_invalid_parameters(params):
    with pytest.raises(ValueError):
        validate(dict(name="PAIO_V1", params=params))


def test_inside_labels_merge_at_original_anchor_and_events_stay_true():
    rows = bars([(0,10),(1,9),(2,8),(3,7),(4,6)])
    engine, values = run(rows)
    assert [v["pattern_ii"] for v in values] == [None,None,1,1,1]
    labels = [o for o in engine.presentation()["objects"] if o["module"] == "io"]
    assert [(o["time"], o["text"],o["detected_at"]) for o in labels] == [(120000,"iiii",120000)]


def test_all_equal_ioi_and_asymmetric_ii_oo_comparisons():
    _, values = run(bars([(0,10),(0,10),(0,10)]))
    assert [values[-1][key] for key in ("pattern_ii","pattern_oo","pattern_ioi")] == [0,0,1]
    assert run(bars([(0,10),(0,10),(-1,10)]))[1][-1]["pattern_oo"] == 1
    assert run(bars([(0,10),(0,10),(0,9)]))[1][-1]["pattern_ii"] == 1
    assert run(bars([(0,10),(1,9),(1,9)]))[1][-1]["pattern_ii"] == 0


def test_ioi_anchor_and_ioii_update():
    engine, _ = run(bars([(0,10),(-1,11),(1,9),(2,8),(3,7)]))
    labels = [o for o in engine.presentation()["objects"] if o["module"] == "io"]
    assert [(o["text"],o["time"],o["detected_at"]) for o in labels] == [("ioiii",60000,120000)]


def test_use_only_controls_drawing_conditions_unchanged():
    rows = bars([(0,1),(3,4),(6,7)])
    engine, values = run(rows, dict(gs_open_use=False,gs_wick_use=False,gs_body_use=False))
    assert all(values[-1][key] == 1 for key in ("gap_open_up","gap_wick_up","gap_body_up"))
    assert not any(o["kind"] == "box" for o in engine.presentation()["objects"])


def test_specific_strings_not_trimmed_and_bypass_use():
    rows = bars([(0,1)]*6)
    engine, values = run(rows, dict(bi_use=False,bi_specific=" 1,02,3"))
    assert [v["specific_bar"] for v in values] == [0,0,1,0,0,0]
    assert [o["text"] for o in engine.presentation()["objects"] if o["module"]=="bar_index"] == ["3"]
    engine, _ = run(rows, dict(bi_specific=""))
    assert [o["text"] for o in engine.presentation()["objects"] if o["module"]=="bar_index"] == ["3","6"]


def test_hlc_outside_double_event_before_coordinate_warmup():
    engine, values = run(bars([(2,8),(1,9)]))
    assert (values[-1]["h_count"],values[-1]["l_count"]) == (1,1)
    labels = [o for o in engine.presentation()["objects"] if o["module"]=="hlc"]
    assert [o["text"] for o in labels] == ["H1","L1"]
    assert all(o["price"] is None for o in labels)
    assert engine.presentation()["readiness"]["hlc"] is False


def test_pine_ema_seed_and_temporary_request_does_not_advance_last():
    rows = bars([(0,2),(2,4),(4,6)])
    engine, values = run(rows, dict(ma_1_length=3))
    assert [v["ema_1"] for v in values] == [1,2,3.5]
    rows[0]["paio_context"] = dict(ema={"2": 2})
    engine, values = run(rows, dict(ma_2_length=3))
    assert [v["ema_2"] for v in values] == [2,2.5,3.5]
    assert engine.state["ma_2_last"] == 2


def test_pv_first_partial_open_not_fabricated_and_plot_break():
    rows = bars([(0,2),(2,4),(4,6)], start=86400000-60000)
    engine, values = run(rows, dict(pv1stSource="open"))
    assert [v["pv_1"] for v in values] == [None,None,None]
    engine, values = run(rows)
    assert [v["pv_1"] for v in values] == [None,1,1]
    line = next(o for o in engine.presentation()["objects"] if o["kind"]=="line" and o["module"]=="pv1st")
    assert line["price"] == 1 and line["right"] == 3*86400000


def test_checkpoint_and_repeated_preview_are_isolated():
    rows = bars([(0,10),(1,9),(2,8)])
    spec = dict(name="PAIO_V1")
    engine = IndicatorState(spec)
    engine.step(rows[0])
    engine.step(rows[1])
    checkpoint = json.loads(json.dumps(engine.checkpoint()))
    live = {**rows[-1],"complete":False}
    first = engine.step(live,provisional=True)
    for _ in range(5):
        assert engine.step(live,provisional=True) == first
        assert engine.checkpoint() == checkpoint
    restored = IndicatorState(spec,checkpoint)
    assert restored.step(rows[-1]) == first
    assert restored.last_presentation["objects"] == engine.last_presentation["objects"]
    assert calculate(rows,spec)["presentation"]["objects"] == restored.last_presentation["objects"]


def test_shared_label_and_box_quotas_and_update_does_not_renew_order():
    rows = bars([(-i,i+1) for i in range(850)])
    engine, _ = run(rows, dict(bi_specific="", bi_step=0))
    objects = engine.presentation()["objects"]
    labels = [o for o in objects if o["kind"]=="label"]
    assert len(labels) == 500
    assert len({o["id"] for o in labels}) == 500
    assert [o["sequence"] for o in labels] == sorted(o["sequence"] for o in labels)
    assert engine.state["index"] == 849


def test_large_input_has_bounded_state_and_linear_cost():
    rows = bars([(-i,i+1) for i in range(12000)])
    engine = PaioState(dict(bi_step=0,bi_specific=""))
    started = time.perf_counter()
    for row in rows:
        engine.step(row)
    assert time.perf_counter()-started < 6
    assert len(engine.state["previous"]) == 2 and len(engine.state["ranges"]) == 100
    assert len(engine.presentation()["objects"]) <= 1500
    assert len(json.dumps(engine.state)) < 700000


def test_does_not_mutate_caller_rows():
    rows = bars([(0,10),(1,9),(2,8)])
    original = copy.deepcopy(rows)
    calculate(rows,dict(name="PAIO_V1"))
    assert rows == original
