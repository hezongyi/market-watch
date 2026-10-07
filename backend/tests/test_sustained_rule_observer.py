import importlib.util
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


observer = module("observe_sustained_rules")
summary = module("summarize_sustained_rules")


def watch(**changes):
    return {"id": "owned", "instrument_id": "instrument", "name": observer.PREFIX + "EURUSD",
        "status": "active", "armed_at": 0, "paused_reason": None,
        "state": {"last_event": 60_000, "previous": {"close": "private-price"}}, **changes}


def live(**changes):
    return {"instrument_id": "instrument", "identity": {"account_scope": "private-account"},
        "quality": "healthy", "connection_epoch": 1, "last_confirmed_m1": 60_000,
        "calendar_verified": False, "quote": {"bid": "private-price", "ask": "private-price",
            "tradeable": True, "source_time": 61_000, "received_at": 61_050}, **changes}


def sample(at, end, **changes):
    rows = observer.sanitize([watch(state={"last_event": end})], [live()], {"owned": "instrument"})
    rows[0].update(changes)
    return {"event": "sample", "at": at, "request_duration_ms": 100, "watches": rows}


def test_sanitization_excludes_prices_account_identity_and_other_users_rules():
    rows = observer.sanitize([watch(), watch(id="unowned")], [live()], {"owned": "instrument"})
    assert len(rows) == 1
    assert rows[0]["last_event"] == 60_000
    assert "private" not in str(rows)
    assert "state" not in rows[0]


def test_changed_identity_is_rejected_and_missing_rule_is_explicit():
    with pytest.raises(ValueError, match="identity changed"):
        observer.sanitize([watch(instrument_id="other")], [live()], {"owned": "instrument"})
    missing = observer.sanitize([], [], {"owned": "instrument"})[0]
    assert missing["watch_present"] is False
    assert missing["source_present"] is False
    assert missing["last_event"] is None


def test_first_last_event_is_baseline_not_observed_execution():
    result = summary.summarize([sample(70_000, 60_000)], 0)["watches"]["owned"]
    assert result["observed_advancements"] == 0
    assert result["rule_close_to_poll_upper_bound"]["samples"] == 0


def test_advancement_delay_and_forward_jumps_do_not_invent_missing_executions():
    result = summary.summarize([sample(70_000, 60_000), sample(85_000, 60_000),
        sample(135_000, 120_000), sample(270_000, 240_000)], 0)["watches"]["owned"]
    assert result["observed_advancements"] == 2
    assert result["observed_forward_jumps_over_one_minute"] == 1
    assert result["unchanged_samples"] == 1
    assert result["longest_observed_unchanged_ms"] == 15_000
    assert result["rule_close_to_poll_upper_bound"]["samples"] == 2
    assert result["rule_close_to_poll_upper_bound"]["p99_ms"] == 30_000


def test_failure_pause_and_state_regression_remain_in_evidence():
    records = [sample(70_000, 60_000), {"event": "poll_failed", "at": 80_000,
        "status_code": 503, "error_type": "HTTPStatusError"},
        sample(90_000, 0, quality="recovering", paused_reason="gap", connection_epoch=2),
        sample(100_000, None, status="cancelled", quote_tradeable=False)]
    result = summary.summarize(records, 0)
    assert len(result["failed_polls"]) == 1
    owned = result["watches"]["owned"]
    assert owned["observed_regressions"] == 1
    assert owned["state_reset_samples"] == 1
    assert owned["epoch_changes"] == 2
    assert owned["paused_reason_counts"]["gap"] == 1
    assert owned["status_counts"]["cancelled"] == 1
    assert owned["tradeable_counts"]["False"] == 1


def test_restart_and_segment_filter_do_not_join_progress():
    records = [sample(70_000, 60_000), {"event": "started", "at": 200_000},
               sample(270_000, 240_000), {"event": "finished", "at": 280_000}]
    result = summary.summarize(records, 0)
    assert result["watches"]["owned"]["observed_advancements"] == 0
    assert len(result["starts"]) == len(result["finishes"]) == 1
    assert summary.summarize(records, 200_000)["samples"] == 1


def test_clock_jumps_and_long_poll_gaps_retained():
    result = summary.summarize([{"event": "poll_clock", "at": 200_000,
        "interval_ms": 40_000, "wall_minus_monotonic_ms": -2000}], 0)
    assert result["max_poll_interval_ms"] == 40_000
    assert result["max_wall_minus_monotonic_ms"] == 2000


def test_api_deployment_events_are_retained_in_rule_summary():
    records = [sample(70_000, 60_000), {"event": "deployment_started", "at": 80_000},
               {"event": "deployment_finished", "at": 100_000}, sample(130_000, 120_000)]
    result = summary.summarize(records, 0)
    assert result["contains_deployment"] is True
    assert len(result["deployments"]) == 2
    assert result["watches"]["owned"]["observed_advancements"] == 1
