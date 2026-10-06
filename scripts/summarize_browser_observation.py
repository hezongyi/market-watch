"""Summarize sanitized Chromium blocks without excluding errors or poor quality."""

import argparse
import json
import math
from collections import Counter
from pathlib import Path


def summarize(records, since=0):
    totals = {}
    starts, finishes = [], []
    deployments = []
    renewals = []
    first = last = None
    blocks = snapshots = heartbeats = errors = opened = 0
    prior_records = 0
    silent_blocks = 0
    max_block_interval = 0
    for record in records:
        if record.get("at", 0) < since:
            prior_records += 1
            continue
        if record["event"] == "started":
            starts.append(record)
        elif record["event"] in ("finished", "failed"):
            finishes.append(record)
        elif record["event"].startswith("deployment_"):
            deployments.append(record)
        elif record["event"] == "session_renewed":
            renewals.append(record)
        elif record["event"] == "block":
            silent_blocks += int(record["heartbeats"] == 0)
            max_block_interval = max(max_block_interval, record["at"] - last if last else 0)
            first = min(first or record["at"], record["at"])
            last = max(last or record["at"], record["at"])
            blocks += 1
            snapshots += record["snapshots"]
            heartbeats += record["heartbeats"]
            errors += record["errors"]
            opened += record["opened"]
            for symbol, item in record["symbols"].items():
                total = totals.setdefault(symbol, {"unique_quotes": 0, "negative_delays": 0,
                    "missing_quote_snapshots": 0,
                    "epoch_changes": 0, "quality_counts": Counter(),
                    "receive_to_browser_ms": Counter(), "source_to_browser_ms": Counter()})
                for key in ("unique_quotes", "negative_delays", "epoch_changes"):
                    total[key] += item[key]
                total["missing_quote_snapshots"] += item.get("missing_quote_snapshots", 0)
                total["quality_counts"].update(item["quality_counts"])
                for key in ("receive_to_browser_ms", "source_to_browser_ms"):
                    total[key].update(item[key])
    # A rate requires one explicitly recorded window. Never stitch restarts or
    # silently infer a denominator from the first successful snapshot.
    duration_ms = (last - starts[0]["at"] if len(starts) == 1 and first is not None
                   and first >= starts[0]["at"] else None)
    elapsed_seconds = duration_ms / 1000 if duration_ms is not None and duration_ms > 0 else None
    for total in totals.values():
        total["visible_quote_update_rate"] = {
            "updates": total["unique_quotes"], "elapsed_seconds": elapsed_seconds,
            "updates_per_second": total["unique_quotes"] / elapsed_seconds if elapsed_seconds else None,
            "meaning": "distinct quote keys within each SSE subscription; reload can recount its first quote; includes startup, silent/error blocks and gaps; 1s snapshots can omit source updates",
            "denominator_status": "single_recorded_window" if elapsed_seconds else "requires_single_recorded_window"}
        for key in ("receive_to_browser_ms", "source_to_browser_ms"):
            raw = total.pop(key)
            histogram = {}
            invalid = 0
            for bucket, frequency in raw.items():
                try:
                    histogram[int(bucket)] = frequency
                except ValueError:
                    invalid += frequency
            count = sum(histogram.values())
            result = {"samples": count, "invalid_samples": invalid, "histogram_resolution_ms": 10}
            for fraction in (.5, .95, .99):
                cumulative = 0
                value = None
                for bucket, frequency in sorted(histogram.items()):
                    cumulative += frequency
                    if cumulative >= math.ceil(count * fraction):
                        value = bucket
                        break
                result[f"p{int(fraction * 100)}_ms"] = value
            total[key] = result
    return {"starts": starts, "finishes": finishes, "deployments": deployments,
        "session_renewals": renewals,
        "measurement_since": since, "prior_records_retained_in_original": prior_records,
        "contains_deployment": bool(deployments), "first_block": first, "last_block": last,
        "blocks": blocks, "snapshots": snapshots, "heartbeats": heartbeats, "errors": errors,
        "zero_heartbeat_blocks": silent_blocks, "max_block_interval_ms": max_block_interval,
        "opened": opened, "symbols": totals,
        "meaning": "quote keys observed through browser SSE; invalid timings separate; 1s snapshots can omit upstream updates",
        "source_clock_offset_verified": False, "two_trading_days_verified": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--since", type=int, default=0, help="UTC ms for an explicitly recorded observation segment")
    args = parser.parse_args()
    with args.file.open() as source:
        result = summarize((json.loads(line) for line in source), args.since)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
