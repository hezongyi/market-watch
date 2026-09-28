"""Read-only runtime evidence; does not fetch prices, create watches or send messages."""

import argparse
import json
import math
import re
from datetime import UTC, datetime
from pathlib import Path

from alerts.storage import Audit, Bar, ImportJob, Instrument, now_ms, transaction
from sqlalchemy import func, select


def stats(values):
    values = sorted(values)

    def quantile(q):
        return round(values[max(0, math.ceil(len(values) * q) - 1)], 3) if values else None

    return {
        "samples": len(values),
        "p50_seconds": quantile(0.5),
        "p95_seconds": quantile(0.95),
        "maximum_seconds": round(values[-1], 3) if values else None,
        "within_30_seconds": sum(v <= 30 for v in values),
        "over_180_seconds": sum(v > 180 for v in values),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=float, default=4)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 0 < args.hours <= 168:
        parser.error("hours must be between 0 and 168")
    now = now_ms()
    left = now - int(args.hours * 3600000)
    report = {
        "generated_at": datetime.fromtimestamp(now / 1000, UTC).isoformat(),
        "window_start": datetime.fromtimestamp(left / 1000, UTC).isoformat(),
        "meaning": "Stored complete candle end to latest revision receipt, including catch-up; not phone delivery latency.",
        "limitations": [
            "No latency for wholly missing candles; gaps need separate coverage/calendar analysis.",
            "Historical imports and price corrections can increase measured latency.",
            "Current quality and recent errors do not prove future availability.",
        ],
        "instruments": [],
    }
    with transaction() as db:
        report["import_tasks"] = dict(
            db.execute(select(ImportJob.status, func.count()).group_by(ImportJob.status)).all()
        )
        for inst in db.scalars(
            select(Instrument).where(Instrument.enabled.is_(True)).order_by(Instrument.id)
        ):
            latest = db.scalar(
                select(func.max(Bar.end)).where(
                    Bar.instrument_id == inst.id, Bar.timeframe == "M1", Bar.complete.is_(True)
                )
            )
            entry = {
                "instrument": inst.id,
                "source": inst.source,
                "basis": inst.basis,
                "current_quality": inst.quality,
                "current_error": bool(inst.error),
                "latest_m1_age_seconds": round((now - latest) / 1000, 3) if latest else None,
                "timeframes": {},
            }
            for frame in ["M1", "M5", "H4", "D1"]:
                rows = db.execute(
                    select(Bar.end, Bar.received_at, Bar.revision).where(
                        Bar.instrument_id == inst.id,
                        Bar.timeframe == frame,
                        Bar.complete.is_(True),
                        Bar.end > left,
                        Bar.end <= now,
                    )
                ).all()
                entry["timeframes"][frame] = {
                    **stats([(received - end) / 1000 for end, received, _ in rows]),
                    "revised_samples": sum(revision > 1 for _, _, revision in rows),
                }
            errors = db.scalars(
                select(Audit).where(
                    Audit.kind == "market_error",
                    Audit.at >= left,
                    Audit.details["instrument"].as_string() == inst.id,
                )
            ).all()
            categories = {}
            for event in errors:
                match = re.search(r"\b(401|403|429|5\d\d)\b", str(event.details.get("error", "")))
                category = "HTTP " + match.group(1) if match else "other provider/network error"
                categories[category] = categories.get(category, 0) + 1
            entry["errors"] = categories
            report["instruments"].append(entry)
        report["worker_age_seconds"] = {
            kind: round((now - at) / 1000, 3)
            for kind, at in db.execute(
                select(Audit.kind, func.max(Audit.at))
                .where(Audit.kind.in_(["market_heartbeat", "import_heartbeat", "notify_heartbeat"]))
                .group_by(Audit.kind)
            )
        }
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
