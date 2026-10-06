"""Summarize sanitized Chromium blocks without excluding errors or poor quality."""

import argparse
import json
import math
from collections import Counter
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    totals = {}
    starts, finishes = [], []
    deployments = []
    first = last = None
    blocks = snapshots = heartbeats = errors = opened = 0
    for line in args.file.read_text().splitlines():
        record = json.loads(line)
        if record["event"] == "started":
            starts.append(record)
        elif record["event"] in ("finished", "failed"):
            finishes.append(record)
        elif record["event"].startswith("deployment_"):
            deployments.append(record)
        elif record["event"] == "block":
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
    for total in totals.values():
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
    print(json.dumps({"starts": starts, "finishes": finishes, "deployments": deployments,
        "contains_deployment": bool(deployments), "first_block": first, "last_block": last,
        "blocks": blocks, "snapshots": snapshots, "heartbeats": heartbeats, "errors": errors,
        "opened": opened, "symbols": totals,
        "meaning": "quote keys observed through browser SSE; invalid timings separate; 1s snapshots can omit upstream updates",
        "source_clock_offset_verified": False, "two_trading_days_verified": False}, indent=2))


if __name__ == "__main__":
    main()
