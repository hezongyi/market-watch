"""Acceptance arithmetic must retain missing, unknown, recovery and duplicate evidence."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/sustained_live_report.py"
SPEC = importlib.util.spec_from_file_location("sustained_live_report", SCRIPT)
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)


def row(start, **changes):
    return {"start": start, "expected": True, "expectation": "observed_source_tradeable",
        "confirmed_at": start + 67_000, "first_attempt": start + 65_000,
        "attempts": 1, "failures": 0, "quote_count": 1,
        "age_histogram": {"100": 1}, "max_interarrival": 1000, **changes}


def audit(end, evaluated, **changes):
    return {"evaluation_completed_at": evaluated, "last_confirmed_end": end, **changes}


def test_elapsed_minutes_partition_without_certifying_unknown_as_closed():
    observations = {0: row(0), 60_000: row(60_000, expected=None,
        expectation="unknown_session", confirmed_at=None), 120_000: row(120_000,
        expected=False, expectation="reviewed_source_closure", confirmed_at=None)}
    result = report.summarize([0, 60_000, 120_000, 180_000], observations, {}, 60_000, 240_000)
    assert result["elapsed_complete_minutes"] == 4
    assert result["known_expected_minutes_including_recovery"] == 1
    assert result["unknown_recorded_minutes"] == 1
    assert result["reviewed_closed_minutes"] == 1
    assert result["unobserved_minutes"] == 1


def test_late_missing_and_failed_attempts_are_not_removed_from_denominators():
    observations = {0: row(0, confirmed_at=91_000, failures=2, attempts=3),
                    60_000: row(60_000, confirmed_at=None, failures=1)}
    result = report.summarize([0, 60_000], observations, {}, 60_000, 151_000)
    assert result["live_expected_minutes"] == 2
    assert result["live_confirmed_minutes"] == 1
    assert result["live_missing_minutes"] == 1
    assert result["live_confirmed_over_30s"] == 1
    assert result["live_missing_over_30s"] == 1
    assert result["failed_attempts"] == 3
    assert result["confirmation"]["p99_ms"] == 31_000


def test_recovery_is_reported_separately_and_in_total_known_denominator():
    observations = {0: row(0, expectation="recovery_source_complete", confirmed_at=500_000),
        60_000: row(60_000, expectation="observed_source_complete", quote_count=0,
                    first_attempt=180_000, confirmed_at=None), 120_000: row(120_000)}
    result = report.summarize([0, 60_000, 120_000], observations, {}, 60_000, 600_000)
    assert result["known_expected_minutes_including_recovery"] == 3
    assert result["known_missing_minutes_including_recovery"] == 1
    assert result["recovery_expected_minutes"] == 2
    assert result["recovery_confirmed_minutes"] == 1
    assert result["live_expected_minutes"] == 1


def test_audit_retries_use_earliest_target_once_and_exclude_unconfirmed_tail():
    observations = {0: row(0), 60_000: row(60_000, confirmed_at=None)}
    audits = {60_000: [audit(60_000, 75_000), audit(60_000, 68_000)],
              120_000: [audit(120_000, 128_000, last_confirmed_end=60_000)]}
    phase = report.summarize([0, 60_000], observations, audits, 60_000, 180_000)[
        "ingestion_and_watch_phase"]
    assert phase["eligible_live_minutes"] == 2
    assert phase["samples"] == 1
    assert phase["target_audit_records"] == 3
    assert phase["minutes_without_target_confirmation_audit"] == 1
    assert phase["p50_ms"] == 8000


def test_evaluation_cannot_backfill_before_rules_exist():
    observations = {0: row(0), 60_000: row(60_000)}
    audits = {60_000: [audit(60_000, 68_000)], 120_000: [audit(120_000, 128_000)]}
    result = report.summarize([0, 60_000], observations, audits, 120_000, 180_000)
    assert result["confirmation"]["samples"] == 2
    assert result["ingestion_and_watch_phase"]["eligible_live_minutes"] == 1
    assert result["ingestion_and_watch_phase"]["samples"] == 1


def test_no_owned_rule_does_not_turn_ingestion_audit_into_computation_evidence():
    result = report.summarize([0], {0: row(0)}, {60_000: [audit(60_000, 68_000)]},
                             None, 120_000)
    assert result["confirmation"]["samples"] == 1
    assert result["ingestion_and_watch_phase"]["eligible_live_minutes"] == 0
    assert result["ingestion_and_watch_phase"]["samples"] == 0


def test_as_of_cutoff_does_not_count_later_confirmation_or_audit():
    result = report.summarize([0], {0: row(0, confirmed_at=100_000)},
                             {60_000: [audit(60_000, 101_000)]}, 60_000, 90_000)
    assert result["live_missing_minutes"] == 1
    assert result["confirmation"]["samples"] == 0
    assert result["ingestion_and_watch_phase"]["samples"] == 0


def test_negative_source_delays_retained_and_nearest_rank():
    result = report.histogram_percentiles({-10: 1, 10: 18, 20: 1})
    assert result["samples"] == 20
    assert result["negative_samples"] == 1
    assert result["p50_ms"] == 10
    assert result["p95_ms"] == 10
    assert result["p99_ms"] == 20
    assert report.percentiles([])["p50_ms"] is None


def test_update_rate_keeps_unknown_closed_and_unobserved_minutes_in_elapsed_denominator():
    observations = {0: row(0, quote_count=120), 60_000: row(60_000, expected=None,
        expectation="unknown_session", quote_count=0), 120_000: row(120_000,
        expected=False, expectation="reviewed_source_closure", quote_count=0)}
    rate = report.summarize([0, 60_000, 120_000, 180_000], observations, {}, 60_000, 240_000)[
        "accepted_quote_update_rate"]
    assert rate["updates"] == 120
    assert rate["elapsed_seconds"] == 240
    assert rate["updates_per_second"] == 0.5
    assert report.summarize([], {}, {}, None, 0)["accepted_quote_update_rate"][
        "updates_per_second"] is None


def test_observation_phases_follow_local_dst_without_certifying_market_hours():
    def stamp(value):
        return int(datetime.fromisoformat(value).replace(tzinfo=UTC).timestamp() * 1000)

    assert report.phase(stamp("2026-10-06T13:00:00"), "EURUSD") == "europe_us_overlap"
    assert report.phase(stamp("2026-10-06T21:00:00"), "XAUUSD") == "gold_17_to_18_NY_candidate"
    assert report.phase(stamp("2026-12-08T22:00:00"), "XAUUSD") == "gold_17_to_18_NY_candidate"
    assert report.phase(stamp("2026-10-10T13:00:00"), "EURUSD") == "other_hours"
