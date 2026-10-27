"""Keep the stage-zero event denominator independent of successful emissions."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "runtime_report", ROOT / "scripts/runtime_market_baseline_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def fixture(modes, signals):
    return {"samples": 61, "interval_s": 2,
            "inputs": [{"business_now": index * 2000, "end": index // 30 * 60000}
                       for index in range(61)],
            "inventory": {"rule_modes": modes}, "final": {"signals": signals}}


def test_duplicate_on_one_rule_cannot_hide_missing_peer():
    result = fixture({"one": "atr_close", "two": "atr_close"}, [
        {"id": "a", "rule": "one", "occurred_at": 60000},
        {"id": "b", "rule": "one", "occurred_at": 60000}])
    oracle = report.event_oracle(result)
    assert oracle["missing_windows"] == 1
    assert oracle["duplicate_events"] == 1


def test_later_duplicate_cannot_replace_missing_early_cross():
    result = fixture({"rule": "ema_intrabar"}, [
        {"id": "a", "rule": "rule", "occurred_at": 54000},
        {"id": "b", "rule": "rule", "occurred_at": 56000},
        {"id": "c", "rule": "rule", "occurred_at": 116000}])
    oracle = report.event_oracle(result)
    assert oracle["missing_windows"] == 1
    assert oracle["duplicate_events"] == 1
    assert oracle["windows"][0]["missing"]


def test_valid_first_judgment_before_commit_observer_is_retained():
    item = {"issued": 1.0, "committed": 2.0, "business_now": 12000, "end": 0}
    entry = {"alert_id": "rule", "health": "ready", "sequence": 12000, "committed": 1.5}
    assert report.first_evaluation([entry], item, "rule", "price_intrabar") == entry
