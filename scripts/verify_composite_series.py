"""Read actual stored supplier M1 through the fixed stitched aggregation primitive."""

import argparse
import json
from decimal import Decimal
from pathlib import Path

from alerts.composite_series import period, read_window
from alerts.storage import CompositeRevision, MarketComposite, MarketDemand, now_ms, transaction
from sqlalchemy import func, select


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    with transaction() as db:
        before = db.scalar(select(func.count()).select_from(MarketDemand))
        composite = db.scalar(select(MarketComposite).order_by(MarketComposite.created_at).limit(1))
        assert composite
        revision = db.get(CompositeRevision, composite.active_revision_id)
        phase, seam, now = revision.rules["aggregation_calendar"], revision.seam, now_ms()
        week_start, week_end = period(seam, "W1", phase)
        assert now - week_start < 8 * 86400000, "Bound the actual read verifier to the current week"
        raw = read_window(db, composite.id, "M1", week_start, week_end, now=now)
        assert raw["bars"]
        assert all((row["segments"][0]["segment"] == "history") == (row["start"] < seam) for row in raw["bars"])
        checks = []
        for frame in ("H4", "D1", "W1", "MN"):
            left, right = period(seam, frame, phase)
            # Include the whole seam bucket so price extrema use both segments.
            partition_end = min(right, (now // 60000 + 1) * 60000)
            report = read_window(db, composite.id, frame, left, partition_end, now=now,
                                 input_revision=raw["input_revision"])
            m1 = read_window(db, composite.id, "M1", left, right, now=now,
                             input_revision=raw["input_revision"])
            members = m1["bars"]
            assert report["bars"] and members
            bar = report["bars"][0]
            assert Decimal(bar["open"]) == Decimal(members[0]["open"])
            assert Decimal(bar["high"]) == max(Decimal(row["high"]) for row in members)
            assert Decimal(bar["low"]) == min(Decimal(row["low"]) for row in members)
            assert Decimal(bar["close"]) == Decimal(members[-1]["close"])
            assert bar["time_closed"] == (bar["end"] <= now)
            assert all(row["source_confirmed"] for row in members)
            checks.append({"timeframe": frame, "start": bar["start"], "end": bar["end"],
                "observed_minutes": bar["observed_minutes"], "unknown_minutes": bar["unknown_minutes"],
                "complete": bar["complete"], "seam_crossing": bar["seam_crossing"],
                "mixed_source": bar["mixed_source"], "matches_stitched_M1": True})
        assert any(item["seam_crossing"] for item in checks if item["timeframe"] in ("W1", "MN"))
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == before
        result = {"environment": "Ubuntu market-watch-three-layer", "composite": composite.id,
            "revision": revision.id, "input_revision": raw["input_revision"],
            "seam": seam, "checks": checks, "raw_m1_count": len(raw["bars"]),
            "no_demand_created": True, "passed": True,
            "scope": "bounded internal actual supplier read; no public chart or strategy claim"}
    Path(args.report).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": True, "timeframes": [item["timeframe"] for item in checks],
                      "raw_m1_count": result["raw_m1_count"]}))


if __name__ == "__main__":
    main()
