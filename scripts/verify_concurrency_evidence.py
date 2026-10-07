"""Read actual source, strategy and owner evidence for the bounded 10-symbol run."""

import json
import math
from collections import Counter
from pathlib import Path

from alerts.storage import (
    CompositeAggregateBar,
    CompositeInputEvent,
    CompositeWatchBinding,
    CompositeWatchJudgment,
    LiveMinute,
    MarketDataset,
    PricingOwner,
    RealtimeMapping,
    Watch,
    now_ms,
    transaction,
)
from sqlalchemy import func, select


def percentile(values, percent):
    return sorted(values)[math.ceil(len(values) * percent) - 1] if values else None


def main():
    report = json.loads(Path("artifacts/data-integration/concurrency10-real-01.json").read_text())
    measured = report["measurement"]
    start = (measured["start"] + 59999) // 60000 * 60000 - 60000
    end = measured["end"] // 60000 * 60000
    rows, delays, event_delays, chain = [], [], [], []
    with transaction() as db:
        for record in report["records"]:
            target_id = db.get(RealtimeMapping, record["mapping_id"]).target_dataset_id
            target = db.get(MarketDataset, target_id)
            watch, binding = db.get(Watch, record["watch_id"]), db.get(CompositeWatchBinding, record["watch_id"])
            assert watch.status == "active" and binding.revision_id == record["revision_id"]
            minutes = list(db.scalars(select(LiveMinute).where(LiveMinute.dataset_id == target_id,
                LiveMinute.start >= start, LiveMinute.start + 60000 <= end).order_by(LiveMinute.start)))
            values = [m.confirmed_at-m.start-60000 for m in minutes if m.expected is True and m.confirmed_at is not None]
            missing = sum(m.expected is True and m.confirmed_at is None for m in minutes)
            assert values and missing == 0
            delays += values
            judgments = list(db.scalars(select(CompositeWatchJudgment).where(
                CompositeWatchJudgment.watch_id == watch.id,
                CompositeWatchJudgment.event_time >= measured["start"],
                CompositeWatchJudgment.event_time <= end).order_by(CompositeWatchJudgment.event_time)))
            observed = [j for j in judgments if j.outcome in ("evaluated", "expired_baseline")]
            event_values = [j.created_at-j.event_time for j in observed]
            event_delays += event_values
            for item in observed:
                event = db.scalar(select(CompositeInputEvent).where(
                    CompositeInputEvent.revision_id == item.revision_id,
                    CompositeInputEvent.input_revision == item.input_revision))
                aggregate = db.get(CompositeAggregateBar, (
                    item.revision_id, "M1", item.event_time - 60000, item.input_revision))
                if event and aggregate:
                    chain.append({"symbol": record["symbol"], "event_time": item.event_time,
                        "input_after_close_ms": event.created_at-item.event_time,
                        "aggregate_after_input_ms": aggregate.created_at-event.created_at,
                        "judgment_after_aggregate_ms": item.created_at-aggregate.created_at})
            rows.append({"symbol":record["symbol"],"target_symbol":target.identity["provider_symbol"],
                "source_minutes":len(minutes),"expected":sum(m.expected is True for m in minutes),
                "unknown":sum(m.expected is None for m in minutes),"missing":missing,
                "failed_attempts":sum(m.failures for m in minutes),"confirmation_ms":values,
                "confirmation_p95_ms":percentile(values,.95),"health":binding.health,
                "health_reason":binding.health_reason,"fixed_binding_unchanged":True,
                "strategy_events":len(observed),"strategy_delay_ms":event_values,
                "all_judgments":len(judgments),"judgment_outcomes":dict(Counter(j.outcome for j in judgments))})
        owners = db.scalar(select(func.count()).select_from(PricingOwner).where(PricingOwner.expires > now_ms()))
        assert owners == 1
    result = {"passed":True,"environment":"Ubuntu isolated market-watch-three-layer",
        "minute_window_start":start,"minute_window_end":end,"excluded_ended_minutes":0,
        "rows":rows,"active_source_owners":owners,"confirmation_samples":len(delays),
        "confirmation_p95_ms":percentile(delays,.95),"confirmation_p99_ms":percentile(delays,.99),
        "candidate_confirmation_target_met":percentile(delays,.95)<=15000 and percentile(delays,.99)<=30000,
        "strategy_samples":len(event_delays),"strategy_p95_ms":percentile(event_delays,.95),
        "strategy_p99_ms":percentile(event_delays,.99),
        "exact_m1_chain_samples":len(chain),"exact_m1_chain":chain,
        "stage_p95_ms":{key:percentile([row[key] for row in chain],.95) for key in (
            "input_after_close_ms","aggregate_after_input_ms","judgment_after_aggregate_ms")},
        "meaning":"source metric ends after ingestion flush and before transaction commit; strategy observation time includes processing. Finite normal-open window, not a 48h quality verdict."}
    print(json.dumps(result,indent=2))


if __name__ == "__main__":
    main()
