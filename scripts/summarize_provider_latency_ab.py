"""Describe paired local first-screen latency, retaining failures in slow rates."""

import argparse
import hashlib
import json
import math
import random
from collections import defaultdict
from pathlib import Path


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    return round(values[max(0, math.ceil(len(values) * fraction) - 1)], 2)


def wilson(successes, total):
    if not total:
        return None
    z = 1.959963984540054
    rate = successes / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    spread = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator
    return [round(100 * (center - spread), 2), round(100 * (center + spread), 2)]


def describe(rows):
    completed = [row["displayed_ms"] for row in rows if row["displayed_ms"] is not None]
    slow = sum(row["slow"] for row in rows)
    demands = [request for row in rows for request in row["cold_requests"]]
    timed = [request for request in demands if request.get("status") == 200 and request.get("timings_ms")]
    reconnects = sum(any("connect_tcp" in name or "start_tls" in name
                        for name in request["timings_ms"]) for request in timed)
    overlapping = 0
    for row in rows:
        intervals = [(r["at_ms"], r["end_ms"]) for r in row["cold_requests"] if "end_ms" in r]
        if any(max(a[0], b[0]) < min(a[1], b[1])
               for index, a in enumerate(intervals) for b in intervals[index + 1:]):
            overlapping += 1
    return {"n": len(rows), "completed": len(completed), "failures": len(rows) - len(completed),
            "slow_count": slow, "slow_percent": round(100 * slow / len(rows), 2) if rows else None,
            "slow_percent_wilson_95ci": wilson(slow, len(rows)),
            "completed_display_ms": {"p50": percentile(completed, 0.5),
                                     "p90": percentile(completed, 0.9),
                                     "p95": percentile(completed, 0.95),
                                     "max": max(completed, default=None)},
            "navigations_with_new_connection": sum(row["new_connection"] for row in rows),
            "successful_timed_cold_demands": len(timed), "timed_demands_with_new_connection": reconnects,
            "cold_demand_new_connection_percent": round(100 * reconnects / len(timed), 2) if timed else None,
            "cold_demands_without_success_timings": len(demands) - len(timed),
            "navigations_with_overlapping_api_requests": overlapping}


def paired_effect(rows):
    by_pair = defaultdict(dict)
    for row in rows:
        by_pair[row["pair"]][row["arm"]] = row
    pairs = [pair for pair in by_pair.values() if set(pair) == {"baseline", "fix"}]
    improved = sum(pair["baseline"]["slow"] and not pair["fix"]["slow"] for pair in pairs)
    worsened = sum(not pair["baseline"]["slow"] and pair["fix"]["slow"] for pair in pairs)
    discordant = improved + worsened
    p_value = min(1.0, 2 * sum(math.comb(discordant, i) for i in range(min(improved, worsened) + 1))
                  / (2 ** discordant)) if discordant else 1.0
    # Stratify by source/scenario, preserving the planned mixture of use cases.
    strata = defaultdict(list)
    for pair in pairs:
        row = pair["baseline"]
        strata[(row["source"], row["scenario"])].append(pair)
    random_source = random.Random(20261002)
    boot_rate, boot_latency = [], []
    for _ in range(10000):
        sample = [random_source.choice(group) for group in strata.values() for _ in group]
        if not sample:
            break
        boot_rate.append(100 * sum(pair["fix"]["slow"] - pair["baseline"]["slow"] for pair in sample) / len(sample))
        completed = [pair for pair in sample if pair["baseline"]["displayed_ms"] is not None
                     and pair["fix"]["displayed_ms"] is not None]
        if completed:
            boot_latency.append(sum(pair["fix"]["displayed_ms"] - pair["baseline"]["displayed_ms"]
                                    for pair in completed) / len(completed))
    both_complete = [pair for pair in pairs if pair["baseline"]["displayed_ms"] is not None
                     and pair["fix"]["displayed_ms"] is not None]
    differences = [pair["fix"]["displayed_ms"] - pair["baseline"]["displayed_ms"] for pair in both_complete]
    return {"complete_pairs": len(pairs), "baseline_slow_fix_fast": improved,
            "baseline_fast_fix_slow": worsened, "discordant_pairs": discordant,
            "mcnemar_exact_two_sided_p": round(p_value, 6),
            "fix_minus_baseline_slow_percentage_points": round(100 * (worsened - improved) / len(pairs), 2) if pairs else None,
            "paired_bootstrap_slow_difference_95ci_pp": [percentile(boot_rate, 0.025), percentile(boot_rate, 0.975)],
            "both_completed_pairs": len(both_complete),
            "completed_paired_mean_latency_difference_ms": round(sum(differences) / len(differences), 2) if differences else None,
            "completed_paired_mean_latency_difference_95ci_ms": [percentile(boot_latency, 0.025), percentile(boot_latency, 0.975)]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    raw = json.loads((args.directory / "raw.json").read_text())
    records = raw["records"]
    groups = {}
    selections = {"all": records}
    for source in ("binance", "oanda"):
        selections[source] = [row for row in records if row["source"] == source]
    for scenario in ("single-first-screen", "two-pane-first-screen"):
        selections[scenario] = [row for row in records if row["scenario"] == scenario]
        for source in ("binance", "oanda"):
            selections[source + "/" + scenario] = [row for row in records
                                                    if row["source"] == source and row["scenario"] == scenario]
    for name, rows in selections.items():
        groups[name] = {arm: describe([row for row in rows if row["arm"] == arm])
                        for arm in ("baseline", "fix")}
        groups[name]["paired_effect"] = paired_effect(rows)
    result = {"complete": raw["complete"], "records": len(records), "groups": groups,
              "errors": raw["errors"],
              "endpoint": "Navigation to public dataReady for all panes plus two frames; >=3000ms or display failure counted slow",
              "percentiles": "Nearest rank, successful displays only; failures remain in primary slow rate",
              "inference_limits": "Intervals/tests assume independent pairs; one host, fixed routes, short time window and balanced scenario mix. Subgroup p-values exploratory and unadjusted. Repeated network observations can be correlated; no production-wide probability claim.",
              "raw_sha256": hashlib.sha256((args.directory / "raw.json").read_bytes()).hexdigest()}
    (args.directory / "summary.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
