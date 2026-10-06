"""Read bounded live evidence in the Ubuntu API container, without changing runtime."""

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

MINUTE = 60_000
LONDON = ZoneInfo("Europe/London")
NEW_YORK = ZoneInfo("America/New_York")
WATCH_PREFIX = "Ubuntu sustained M1 acceptance "


def iso(stamp):
    return datetime.fromtimestamp(stamp / 1000, UTC).isoformat()


def percentiles(values):
    ordered = sorted(values)
    return {"samples": len(ordered), "negative_samples": sum(value < 0 for value in ordered),
            **{f"p{percent}_ms": ordered[math.ceil(len(ordered) * percent / 100) - 1]
               if ordered else None for percent in (50, 95, 99)}}


def histogram_percentiles(histogram):
    count = sum(histogram.values())
    result = {"samples": count, "negative_samples": sum(
        frequency for bucket, frequency in histogram.items() if bucket < 0),
        "histogram_resolution_ms": 10}
    for percent in (50, 95, 99):
        cumulative = 0
        result[f"p{percent}_ms"] = None
        for bucket, frequency in sorted(histogram.items()):
            cumulative += frequency
            if cumulative >= math.ceil(count * percent / 100):
                result[f"p{percent}_ms"] = bucket
                break
    return result


def phase(stamp, symbol):
    utc = datetime.fromtimestamp(stamp / 1000, UTC)
    london, ny = utc.astimezone(LONDON), utc.astimezone(NEW_YORK)
    if symbol == "XAUUSD" and ny.hour == 17:
        return "gold_17_to_18_NY_candidate"
    europe = london.weekday() < 5 and 8 <= london.hour < 17
    america = ny.weekday() < 5 and 8 <= ny.hour < 17
    return ("europe_us_overlap" if europe and america else "europe_business_hours"
            if europe else "us_business_hours" if america else "other_hours")


def is_recovery(row):
    return row["expectation"] == "recovery_source_complete" or (
        row["expectation"] == "observed_source_complete" and row["quote_count"] == 0
        and (row["first_attempt"] == 0
             or row["first_attempt"] - row["start"] - MINUTE > 30_000))


def summarize(starts, observations, audits, evaluation_since, cutoff):
    rows = [observations[start] for start in starts if start in observations]
    expected = [row for row in rows if row["expected"] is True]
    # Retrospective cutoffs never count a confirmation which arrived later.
    confirmed = [row for row in expected if row["confirmed_at"] is not None
                 and row["confirmed_at"] <= cutoff]
    live = [row for row in expected if not is_recovery(row)]
    live_confirmed = [row for row in confirmed if not is_recovery(row)]
    confirmed_starts = {row["start"] for row in live_confirmed}
    delays = [row["confirmed_at"] - row["start"] - MINUTE for row in live_confirmed]
    quote_ages = Counter()
    for row in rows:
        quote_ages.update({int(bucket): count for bucket, count in row["age_histogram"].items()})
    eligible = [row for row in live if evaluation_since is not None
                and row["start"] + MINUTE >= evaluation_since]
    evaluation = []
    for row in eligible:
        end = row["start"] + MINUTE
        matching = [item for item in audits.get(end, [])
                    if item["evaluation_completed_at"] <= cutoff
                    and item["last_confirmed_end"] >= end]
        if matching:
            # Retries/revisions are retained as audit counts, not extra minutes.
            earliest = min(matching, key=lambda item: item["evaluation_completed_at"])
            evaluation.append(earliest["evaluation_completed_at"] - end)
    return {"elapsed_complete_minutes": len(starts), "recorded_minutes": len(rows),
        "unobserved_minutes": len(starts) - len(rows),
        "unknown_recorded_minutes": sum(row["expected"] is None for row in rows),
        "reviewed_closed_minutes": sum(row["expected"] is False for row in rows),
        "expectation_counts": dict(Counter(row["expectation"] for row in rows)),
        "known_expected_minutes_including_recovery": len(expected),
        "known_missing_minutes_including_recovery": len(expected) - len(confirmed),
        "live_expected_minutes": len(live), "live_confirmed_minutes": len(live_confirmed),
        "live_missing_minutes": len(live) - len(live_confirmed),
        "live_confirmed_over_30s": sum(delay > 30_000 for delay in delays),
        "live_missing_over_30s": sum(row["start"] not in confirmed_starts
            and cutoff - row["start"] - MINUTE > 30_000 for row in live),
        "recovery_expected_minutes": sum(is_recovery(row) for row in expected),
        "recovery_confirmed_minutes": sum(is_recovery(row) for row in confirmed),
        "attempts": sum(row["attempts"] for row in rows),
        "failed_attempts": sum(row["failures"] for row in rows),
        "confirmation": percentiles(delays),
        "source_to_receiver": histogram_percentiles(quote_ages),
        "quotes": sum(row["quote_count"] for row in rows),
        "max_interarrival_ms": max((row["max_interarrival"] for row in rows), default=0),
        "ingestion_and_watch_phase": {"eligible_live_minutes": len(eligible),
            "minutes_without_target_confirmation_audit": len(eligible) - len(evaluation),
            "target_audit_records": sum(len(audits.get(row["start"] + MINUTE, []))
                                        for row in eligible),
            **percentiles(evaluation)}}


def collect(since, until, evaluation_since):
    from alerts.storage import Audit, LiveMinute, LiveState, MarketDataset, Watch, transaction
    from sqlalchemy import select, text

    with transaction() as db:
        # A coherent, read-only snapshot; no new containers or worker restarts.
        db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        captured = int(db.scalar(text("SELECT EXTRACT(EPOCH FROM now()) * 1000")))
        cutoff = min(until or captured, captured)
        if cutoff <= since or cutoff - since > 72 * 60 * MINUTE:
            raise ValueError("Require a positive observation window no longer than 72 hours")
        end = cutoff // MINUTE * MINUTE
        starts = list(range(since, end, MINUTE))
        datasets = list(db.scalars(select(MarketDataset).join(LiveState).where(
            LiveState.connection != "inactive", MarketDataset.logical_symbol.in_(["EURUSD", "XAUUSD"]))))
        dataset_ids = [dataset.id for dataset in datasets]
        observed = defaultdict(dict)
        fields = ("start", "expected", "expectation", "confirmed_at", "first_attempt", "attempts",
                  "failures", "quote_count", "age_histogram", "max_interarrival")
        for row in db.scalars(select(LiveMinute).where(LiveMinute.dataset_id.in_(dataset_ids),
                LiveMinute.start >= since, LiveMinute.start < end)):
            observed[row.dataset_id][row.start] = {key: getattr(row, key) for key in fields}
        audits = defaultdict(lambda: defaultdict(list))
        audit_count = Counter()
        for audit in db.scalars(select(Audit).where(Audit.kind.in_([
                "pricing_confirmed", "pricing_connection", "pricing_recovered"]),
                Audit.at >= since, Audit.at <= cutoff)):
            details = audit.details
            dataset_id = details.get("dataset")
            if dataset_id not in dataset_ids:
                continue
            audit_count[(dataset_id, audit.kind)] += 1
            if (audit.kind == "pricing_confirmed" and details.get("evaluation_completed_at")
                    and details["window_end"] - details["window_start"] <= 3 * MINUTE):
                audits[dataset_id][details["window_end"]].append(details)
        result = []
        for dataset in datasets:
            observations, target_audits = observed[dataset.id], audits[dataset.id]
            groups = defaultdict(list)
            for start in starts:
                groups[(iso(start)[:13] + ":00Z", phase(start, dataset.logical_symbol))].append(start)
            watches = list(db.scalars(select(Watch).where(Watch.instrument_id == dataset.instrument_id,
                                                         Watch.name.startswith(WATCH_PREFIX))))
            first_owned_close = min(((watch.armed_at // MINUTE + 1) * MINUTE
                                     for watch in watches), default=None)
            eligible_since = (max(evaluation_since, first_owned_close)
                              if first_owned_close is not None else None)
            result.append({"dataset_id": dataset.id, "symbol": dataset.logical_symbol,
                "source": dataset.identity["source"], "environment": dataset.identity["environment"],
                "evaluation_first_eligible_close": eligible_since,
                "total": summarize(starts, observations, target_audits, eligible_since, cutoff),
                "by_utc_hour_and_observation_phase": [{"utc_hour": hour, "phase": label,
                    "first_minute": iso(part[0]), "last_minute": iso(part[-1]),
                    **summarize(part, observations, target_audits, eligible_since, cutoff)}
                    for (hour, label), part in sorted(groups.items())],
                "connection_audits": {kind: audit_count[(dataset.id, kind)]
                    for kind in ("pricing_connection", "pricing_recovered", "pricing_confirmed")},
                "current_owned_watches": [{"id": watch.id, "armed_at": watch.armed_at,
                    "status": watch.status, "paused_reason": watch.paused_reason,
                    "last_event": watch.state.get("last_event")} for watch in watches]})
    return {"captured_at": captured, "cutoff": cutoff, "since": since,
        "complete_minutes_end_exclusive": end, "evaluation_first_eligible_close": evaluation_since,
        "host": "Ubuntu local isolated Docker", "project": "market-watch-data-integration",
        "snapshot": "PostgreSQL repeatable read, read only", "datasets": result,
        "percentile_method": "nearest_rank; completed successful samples, denominators reported separately",
        "phase_meaning": "London/NY weekday 08:00–17:00 observation bins; gold NY17–18 is candidate only, not certified closure",
        "evaluation_meaning": "ingestion and watch phase flush after requested and owned-watch start; excludes commit/delivery; audits do not record individual watch executions or prove continuous watch activity",
        "retrospective_limit": "minute expectation/attempt/quote totals reflect capture-time rows, not event-time history",
        "source_clock_offset_verified": False, "two_trading_days_verified": False,
        "mt4_deferred": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", type=int, required=True, help="First full source minute, UTC ms")
    parser.add_argument("--until", type=int, default=0, help="Exclusive UTC ms; defaults to capture time")
    parser.add_argument("--evaluation-since", type=int, required=True,
                        help="First eligible completed candle close after acceptance watches were armed")
    args = parser.parse_args()
    if args.since % MINUTE or args.evaluation_since % MINUTE:
        parser.error("Minute boundaries required")
    if args.evaluation_since < args.since:
        parser.error("Evaluation cannot start before the observation window")
    print(json.dumps(collect(args.since, args.until, args.evaluation_since), indent=2))
