import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/summarize_browser_observation.py"
SPEC = importlib.util.spec_from_file_location("browser_summary", SCRIPT)
summary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary)


def block(at, updates=30, errors=0, heartbeats=29, **changes):
    return {"event": "block", "at": at, "snapshots": 20, "heartbeats": heartbeats,
        "errors": errors, "opened": 0, "symbols": {"EURUSD": {
            "unique_quotes": updates, "negative_delays": 0, "epoch_changes": 0,
            "quality_counts": {"healthy": 10, "stale": 10}, "missing_quote_snapshots": 1,
            "receive_to_browser_ms": {"100": updates}, "source_to_browser_ms": {"200": updates}}},
        **changes}


def test_rate_includes_startup_failed_silent_blocks_and_unrecorded_gaps():
    records = [{"event": "started", "at": 0}, block(30_000),
               block(60_000, updates=0, errors=2, heartbeats=0), block(120_000)]
    result = summary.summarize(records)
    rate = result["symbols"]["EURUSD"]["visible_quote_update_rate"]
    assert rate["updates"] == 60
    assert rate["elapsed_seconds"] == 120
    assert rate["updates_per_second"] == 0.5
    assert result["errors"] == 2
    assert result["zero_heartbeat_blocks"] == 1
    assert result["max_block_interval_ms"] == 60_000
    assert result["symbols"]["EURUSD"]["quality_counts"]["stale"] == 30


def test_multiple_windows_require_explicit_segment_instead_of_stitched_rate():
    records = [{"event": "started", "at": 0}, block(30_000),
               {"event": "finished", "at": 40_000},
               {"event": "started", "at": 100_000}, block(130_000)]
    combined = summary.summarize(records)["symbols"]["EURUSD"]["visible_quote_update_rate"]
    assert combined["elapsed_seconds"] is None
    assert combined["updates_per_second"] is None
    segmented = summary.summarize(records, since=100_000)
    rate = segmented["symbols"]["EURUSD"]["visible_quote_update_rate"]
    assert rate["elapsed_seconds"] == 30
    assert rate["updates_per_second"] == 1
    assert segmented["prior_records_retained_in_original"] == 3


def test_missing_start_zero_duration_and_orphan_blocks_do_not_invent_rate():
    for records in ([block(30_000)], [{"event": "started", "at": 0}, block(0)],
                    [block(30_000), {"event": "started", "at": 50_000}, block(60_000)]):
        rate = summary.summarize(records)["symbols"]["EURUSD"]["visible_quote_update_rate"]
        assert rate["updates_per_second"] is None
        assert rate["denominator_status"] == "requires_single_recorded_window"


def test_percentiles_keep_invalid_samples_separate_and_retain_negative_delays():
    record = block(30_000)
    record["symbols"]["EURUSD"]["receive_to_browser_ms"] = {"-10": 1, "100": 18, "200": 1,
                                                           "invalid": 3}
    stats = summary.summarize([record])["symbols"]["EURUSD"]["receive_to_browser_ms"]
    assert stats["samples"] == 20
    assert stats["invalid_samples"] == 3
    assert stats["p95_ms"] == 100
    assert stats["p99_ms"] == 200
