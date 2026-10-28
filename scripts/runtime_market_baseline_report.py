"""Summarize stage-zero evidence without hiding missed input/rule pairs."""

import argparse
import gzip
import json
from pathlib import Path


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {"n": 0}
    return {"n": len(ordered), "p50": ordered[len(ordered) // 2],
            "p95": ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
            "p99": ordered[min(len(ordered) - 1, int(len(ordered) * .99))],
            "max": ordered[-1]}


def load_lines(path):
    if path.exists():
        content = path.read_text()
    else:
        with gzip.open(path.with_suffix(path.suffix + ".gz"), "rt") as stream:
            content = stream.read()
    return [json.loads(line) for line in content.splitlines()]


def event_oracle(result):
    if result["samples"] != 61 or result["interval_s"] != 2:
        return {"applicable": False, "reason": "Oracle covers the formal 61x2s fixture"}
    windows = []
    for rule, kind in result["inventory"]["rule_modes"].items():
        if kind.endswith("intrabar"):
            for left, right in ((3, 14), (27, 38), (58, 61)):
                times = [item["business_now"] for item in result["inputs"][left:right]]
                windows.append({"rule": rule, "kind": kind, "samples": [left, right - 1],
                                "allowed_times": times})
        else:
            # The first confirmed rising close is the minute ending at sample30.
            windows.append({"rule": rule, "kind": kind, "samples": [30, 30],
                            "allowed_times": [result["inputs"][30]["end"]]})
    matched = set()
    for window in windows:
        allowed_times = window.pop("allowed_times")
        matches = [item["id"] for item in result["final"]["signals"]
                   if item["rule"] == window["rule"]
                   and item["occurred_at"] in allowed_times]
        window["signals"] = matches
        window["missing"] = not matches
        window["duplicates"] = max(0, len(matches) - 1)
        matched.update(matches)
    return {"applicable": True, "windows": windows,
            "missing_windows": sum(item["missing"] for item in windows),
            "duplicate_events": sum(item["duplicates"] for item in windows),
            "events_outside_expected_windows": sorted(
                item["id"] for item in result["final"]["signals"] if item["id"] not in matched)}


def first_evaluation(evaluations, item, rule, kind):
    sequence = item["business_now"] if kind.endswith("intrabar") else item["end"]
    return next((entry for entry in evaluations if entry["alert_id"] == rule
                 and entry["health"] == "ready" and entry["sequence"] == sequence
                 and entry["committed"] >= item["issued"]), None)


def summarize(path):
    result = json.loads(path.read_text())
    schema = result["schema"]
    logs = {role: load_lines(path.parent / f"{schema}-{role}.jsonl")
            for role in result["workers"]}
    if result.get("profile_runtime"):
        runtime = logs["runtime"]
        if not result.get("independent_alert"):
            logs["alert"] = [item for item in runtime
                             if item["type"] in ("evaluated", "signal")]
        logs["aggregate"] = load_lines(path.parent / f"{schema}-aggregate.jsonl")
    if any(code != 0 for code in result["workers"].values()):
        raise RuntimeError("Worker failure in " + path.name)
    if any(item["type"] == "error" for rows in logs.values() for item in rows):
        raise RuntimeError("Worker error in " + path.name)
    evaluations = [item for item in logs["alert"] if item["type"] == "evaluated"]
    publications = [item for item in logs["aggregate"] if item["type"] == "aggregate"]
    stats = {}
    missing = []
    source = []
    aggregate = []
    confirmed_count = 0
    terminal_after = {}
    for rule in result["final"]["rules"]:
        if rule["status"] == "completed":
            events = [entry["occurred_at"] for entry in result["final"]["signals"]
                      if entry["rule"] == rule["id"]]
            if events:
                terminal_after[rule["id"]] = max(events)
    terminal_pairs = 0
    for item in result["inputs"]:
        source.append(item["committed"] - item["issued"])
        visible = next((entry["at"] for entry in publications
                        if entry["published_revision"] >= item["input_revision"]), None)
        if item["confirmed_minute"]:
            confirmed_count += 1
        if visible is not None and item["confirmed_minute"]:
            aggregate.append(visible - item["issued"])
        for rule, kind in result["inventory"]["rule_modes"].items():
            intrabar = kind.endswith("intrabar")
            if not intrabar and not item["confirmed_minute"]:
                continue
            sequence = item["business_now"] if intrabar else item["end"]
            if rule in terminal_after and sequence > terminal_after[rule]:
                terminal_pairs += 1
                continue
            group = stats.setdefault(kind, {"expected": 0, "processed": 0,
                "input_to_evaluated_s": [], "input_commit_observer_to_evaluated_s": [],
                "visible_to_evaluated_s": []})
            group["expected"] += 1
            entry = first_evaluation(evaluations, item, rule, kind)
            if entry is None:
                missing.append({"sample": item["sample"], "rule": rule, "kind": kind})
                continue
            group["processed"] += 1
            group["input_to_evaluated_s"].append(entry["committed"] - item["issued"])
            group["input_commit_observer_to_evaluated_s"].append(
                entry["committed"] - item["committed"])
            if visible is not None and not intrabar:
                # Observer writes are upper-bound timing evidence; a negative
                # value means the visibility observer lagged, not time travel.
                group["visible_to_evaluated_s"].append(entry["committed"] - visible)
    for group in stats.values():
        for metric in ("input_to_evaluated_s", "input_commit_observer_to_evaluated_s",
                       "visible_to_evaluated_s"):
            group[metric] = distribution(group[metric])
    metrics = {role: next((item for item in logs[role] if item["type"] == "metrics"), None)
               for role in result["workers"]}
    foreground = [item["at"] - item["started"] for item in logs["provider"]
                  if item["type"] == "provider"]
    projected = [item["at"] for item in logs["projection"]
                 if item["type"] == "projection" and item["count"]]
    delivered = [item["at"] for item in logs["notification"]
                 if item["type"] == "delivery" and item["worked"]]
    signals = [item for item in logs["alert"] if item["type"] == "signal"]
    accepts = [item for item in logs["notification"] if item["type"] == "ntfy_accepted"]
    notices = [item for item in logs["projection"] if item["type"] == "projected"]
    event_latencies = []
    for signal in signals:
        kind = result["inventory"]["rule_modes"][signal["rule"]]
        source_item = next((item for item in result["inputs"]
            if (item["business_now"] if kind.endswith("intrabar") else item["end"]) == signal["occurred_at"]), None)
        receipt = next((item for item in accepts if item["signal"] == signal["signal"]), None)
        notice = next((item for item in notices if item["source"] == signal["signal"]), None)
        event_latencies.append({"signal": signal["signal"], "kind": kind,
            "input_to_signal_s": signal["committed"] - source_item["issued"] if source_item else None,
            "input_commit_observer_to_signal_s": signal["committed"] - source_item["committed"] if source_item else None,
            "signal_to_projected_observer_s": notice["committed"] - signal["committed"] if notice else None,
            "signal_to_ntfy_accepted_s": receipt["accepted"] - signal["committed"] if receipt else None,
            "outbox_wait_to_attempt_s": receipt["started"] - signal["committed"] if receipt else None})
    # The formal 61x2s fixture has three rising intrabar windows and a single
    # confirmed rising edge. Keep this denominator independent of emitted rows.
    expected_counts = ({"price_intrabar": 6, "ema_intrabar": 3,
                        "price_close": 2, "atr_close": 2}
                       if result["samples"] == 61 and result["interval_s"] == 2 else None)
    actual_counts = {kind: sum(result["inventory"]["rule_modes"][item["rule"]] == kind
                              for item in result["final"]["signals"])
                     for kind in set(result["inventory"]["rule_modes"].values())}
    final_signals = {item["id"] for item in result["final"]["signals"]}
    accepted_signals = {item["signal"] for item in accepts}
    projected_signals = {item["source"] for item in notices}
    requests = [item for item in logs["provider"] if item["type"] == "provider_request"]
    candidate = [item for item in logs["history"] if item["type"] == "candidate"]
    ready = next((item for item in candidate if item["readiness"] and item["readiness"]["ready"]), None)
    queued = result["inventory"]["candidate_queued_at"]
    return {"artifact": path.name, "scenario": result["scenario"],
            "source_evidence": result.get("source_evidence"),
            "profile_runtime": result.get("profile_runtime", False),
            "independent_alert": result.get("independent_alert", False),
            "history_pause_s": result["history_pause_s"], "samples": result["samples"],
            "wall_s": result["wall_s"], "source_ingestion_s": distribution(source),
            "data_worker_paused_at": result.get("data_worker_paused_at"),
            "input_window_ended": result.get("input_window_ended"),
            "workers": result.get("workers"),
            "input_to_M1_publication_observer_s": distribution(aggregate),
            "confirmed_inputs": confirmed_count,
            "unpublished_confirmed_inputs": confirmed_count - len(aggregate),
            "rules": stats, "unprocessed_input_rule_pairs": missing,
            "pairs_after_rule_completed_excluded": terminal_pairs,
            "foreground_poll_turn_s": distribution(foreground),
            "foreground_actual_requests": len(requests),
            "foreground_actual_request_s": distribution([item["finished"] - item["started"] for item in requests]),
            "candidate_ready_observed": ready is not None,
            "candidate_ready_after_queued_s": ready["at"] - queued if ready else None,
            "candidate_first": candidate[0] if candidate else None,
            "candidate_last": candidate[-1] if candidate else None,
            "event_latencies": event_latencies,
            "event_oracle": event_oracle(result),
            "expected_signal_counts": expected_counts, "actual_signal_counts": actual_counts,
            "missing_expected_signals": ({kind: max(0, count - actual_counts.get(kind, 0))
                                          for kind, count in expected_counts.items()}
                                         if expected_counts else None),
            "unexpected_signal_counts": ({kind: max(0, count - expected_counts.get(kind, 0))
                                           for kind, count in actual_counts.items()}
                                          if expected_counts else None),
            "signals_without_acceptance": sorted(final_signals - accepted_signals),
            "signals_without_projection": sorted(final_signals - projected_signals),
            "signals_without_commit_observation": sorted(final_signals - {
                item["signal"] for item in signals}),
            "projection_nonempty_rounds": len(projected), "delivery_nonempty_rounds": len(delivered),
            "signal_count": len(result["final"]["signals"]),
            "final_rule_health": [{"kind": result["inventory"]["rule_modes"][row["id"]],
                                  "health": row["health"], "count": row["count"]}
                                  for row in result["final"]["rules"]],
            "backlog_first": result["resources"][0]["backlog"],
            "backlog_last": result["resources"][-1]["backlog"],
            "roles": metrics, "limitations": result["limitations"] + (
                ["One or more owner metric summaries were not emitted before container stop"]
                if any(value is None for value in metrics.values()) else []),
            "note": "Percentiles exclude missing pairs only from numeric samples; missing denominator is explicit. "
                    "Input latency uses issued time for a conservative upper bound; actual commit is bracketed "
                    "by issued and committed observer. Observer-based lower bounds remain explicit. "
                    "No latency acceptance verdict is made before user confirmation."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    paths = sorted([*args.directory.glob("runtime_baseline_*.json"),
                    *args.directory.glob("runtime_compose_*.json")])
    if not paths:
        raise RuntimeError("No completed baseline artifacts")
    output = {"runs": [summarize(path) for path in paths]}
    (args.directory / "baseline-summary.json").write_text(json.dumps(output, indent=2))
    print(json.dumps({"runs": len(paths), "output": "baseline-summary.json"}))


if __name__ == "__main__":
    main()
