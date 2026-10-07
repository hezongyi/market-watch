"""Summarize rule observations; sampled progress does not prove every execution."""

import argparse
import json
import math
from collections import Counter
from pathlib import Path


def summarize(records, since):
    starts, finishes, clocks, authentications, failures = [], [], [], [], []
    deployments = []
    watches, last = {}, {}
    samples = 0
    first_sample = last_sample = None
    max_interval = max_request_duration = max_clock_step = 0
    for record in records:
        if record["at"] < since:
            continue
        event = record["event"]
        if event == "started":
            starts.append(record)
            last = {}  # Preserve restarts as segments; never infer an advancement across them.
        elif event == "finished":
            finishes.append(record)
        elif event == "receiver_clock":
            clocks.append(record)
        elif event == "authenticated":
            authentications.append(record)
        elif event == "poll_failed":
            failures.append(record)
        elif event.startswith("deployment_"):
            deployments.append(record)
        elif event == "poll_clock":
            max_interval = max(max_interval, record["interval_ms"])
            max_clock_step = max(max_clock_step, abs(record["wall_minus_monotonic_ms"]))
        elif event == "sample":
            samples += 1
            first_sample = first_sample if first_sample is not None else record["at"]
            last_sample = record["at"]
            max_request_duration = max(max_request_duration, record["request_duration_ms"])
            for row in record["watches"]:
                key = row["watch_id"]
                result = watches.setdefault(key, {"instrument_id": row["instrument_id"],
                    "samples": 0, "missing_watch_samples": 0, "missing_source_samples": 0,
                    "missing_last_event_samples": 0, "state_reset_samples": 0,
                    "status_counts": Counter(), "quality_counts": Counter(),
                    "paused_reason_counts": Counter(), "tradeable_counts": Counter(),
                    "observed_advancements": 0, "observed_forward_jumps_over_one_minute": 0,
                    "observed_regressions": 0, "epoch_changes": 0,
                    "unchanged_samples": 0, "longest_observed_unchanged_ms": 0,
                    "first_last_event": row["last_event"], "last_last_event": None,
                    "observation_delay_upper_bounds_ms": []})
                result["samples"] += 1
                result["missing_watch_samples"] += not row["watch_present"]
                result["missing_source_samples"] += not row["source_present"]
                result["status_counts"][str(row["status"])] += 1
                result["quality_counts"][str(row["quality"])] += 1
                result["paused_reason_counts"][str(row["paused_reason"])] += 1
                result["tradeable_counts"][str(row["quote_tradeable"])] += 1
                current = row["last_event"]
                result["missing_last_event_samples"] += current is None
                previous = last.get(key)
                result["last_last_event"] = current
                if previous:
                    result["epoch_changes"] += previous["epoch"] != row["connection_epoch"]
                    result["state_reset_samples"] += current is None and previous["value"] is not None
                    if current is not None and previous["value"] is not None:
                        if current > previous["value"]:
                            result["observed_advancements"] += 1
                            result["observed_forward_jumps_over_one_minute"] += (
                                current - previous["value"] > 60_000)
                            result["observation_delay_upper_bounds_ms"].append(record["at"] - current)
                        elif current < previous["value"]:
                            result["observed_regressions"] += 1
                        else:
                            result["unchanged_samples"] += 1
                            result["longest_observed_unchanged_ms"] = max(
                                result["longest_observed_unchanged_ms"],
                                record["at"] - previous["unchanged_since"])
                unchanged_since = (previous["unchanged_since"] if previous
                                   and current == previous["value"] else record["at"])
                last[key] = {"value": current, "epoch": row["connection_epoch"],
                             "unchanged_since": unchanged_since}
    for result in watches.values():
        values = sorted(result.pop("observation_delay_upper_bounds_ms"))
        result["rule_close_to_poll_upper_bound"] = {
            "samples": len(values), "negative_samples": sum(value < 0 for value in values),
            **{f"p{percent}_ms": values[math.ceil(len(values) * percent / 100) - 1]
               if values else None for percent in (50, 95, 99)}}
    return {"measurement_since": since, "starts": starts, "finishes": finishes,
        "deployments": deployments, "contains_deployment": bool(deployments),
        "samples": samples, "first_sample": first_sample, "last_sample": last_sample,
        "failed_polls": failures, "authentications": authentications, "receiver_clocks": clocks,
        "max_poll_interval_ms": max_interval, "max_request_duration_ms": max_request_duration,
        "max_wall_minus_monotonic_ms": max_clock_step, "watches": watches,
        "meaning": "read-only sampled rule last_event; first value is baseline; no inferred executions across jumps or restarts; per-watch delay is upper bound including polling",
        "source_clock_offset_verified": False, "two_trading_days_verified": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--since", type=int, default=0)
    args = parser.parse_args()
    with args.file.open() as source:
        result = summarize((json.loads(line) for line in source), args.since)
    print(json.dumps(result, indent=2))
