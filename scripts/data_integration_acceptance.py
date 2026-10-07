"""Run inside the isolated Ubuntu API container; print credential-free evidence."""

import argparse
import json
import math
from datetime import datetime

from alerts.history_versions import create_version, version_report
from alerts.live_pricing import measurements, snapshots
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import legacy_inventory, register_dataset
from alerts.storage import Audit, HistoryVersion, MarketDataset, now_ms, transaction
from sqlalchemy import select


def stamp(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def seed():
    # Candidate calendars remain explicitly unverified. Missing weekend,
    # holiday and source minutes stay unknown in the version manifest.
    created = []
    with transaction() as db:
        for start, end, purpose in [
            ("2026-10-05T01:00:00Z", "2026-10-05T02:00:00Z", "bounded-live-acceptance"),
            ("2016-10-06T00:00:00Z", "2026-10-06T00:00:00Z", "ten-year-coverage"),
        ]:
            for symbol, precision in (("EURUSD", 5), ("XAUUSD", 3)):
                identity = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
                    account_scope="public", provider_symbol=symbol[:3] + "/" + symbol[3:],
                    basis="bid", calendar_version="ny17-candidate-v1")
                register_dataset(db, identity, logical_symbol=symbol, label=symbol,
                    calendar="ny17", precision=precision, volume_kind="quantity",
                    volume_unit="source_quantity")
                previous = db.scalar(select(HistoryVersion).where(HistoryVersion.dataset_id == identity.key,
                    HistoryVersion.start == stamp(start), HistoryVersion.end == stamp(end)))
                ident = previous.id if previous else create_version(db, identity.key, stamp(start), stamp(end))
                created.append({"symbol": symbol, "purpose": purpose, "version": ident})
    return {"calendar_verified": False, "versions": created}


def report(since=0, compact=False):
    current = snapshots()
    with transaction() as db:
        versions = [version_report(db, ident) for ident in db.scalars(select(HistoryVersion.id))]
        inventory = legacy_inventory(db)
        datasets = [{"id": row.id, "instrument": row.instrument_id, "identity": row.identity}
                    for row in db.scalars(select(MarketDataset))]
        evaluations = {}
        for audit in db.scalars(select(Audit).where(Audit.kind == "pricing_confirmed")):
            details = audit.details
            completed = details.get("evaluation_completed_at")
            if completed is None or details["window_end"] - 60000 < since:
                continue
            if details["window_end"] - details["window_start"] > 3 * 60000:
                continue  # Historical recovery is not live confirmation latency.
            item = evaluations.setdefault(details["dataset"], {"samples": 0, "delays": [],
                                                                "processing": []})
            item["samples"] += 1
            item["delays"].append(details["m1_to_evaluation_ms"])
            item["processing"].append(details["processing_ms"])
        for item in evaluations.values():
            for key in ("delays", "processing"):
                values = sorted(item.pop(key))
                item[key + "_p95_ms"] = values[math.ceil(len(values) * .95) - 1]
                item[key + "_p99_ms"] = values[math.ceil(len(values) * .99) - 1]
        if compact:
            versions = [{key: version[key] for key in ("id", "dataset_id", "start", "end",
                         "cursor", "status", "error", "attempts", "next_at")}
                        | {"progress": round((version["cursor"] - version["start"]) /
                            (version["end"] - version["start"]), 6)} for version in versions]
            inventory = [row for row in inventory if row["bars"]]
            datasets = [row for row in datasets if row["identity"]["source"] == "dukascopy"]
            current = [{key: row[key] for key in ("dataset_id", "logical_symbol", "quality",
                       "connection_epoch", "last_confirmed_m1", "calendar_verified", "error")}
                       for row in current]
    return {"observed_at": now_ms(), "host": "Ubuntu local isolated Docker",
        "project": "market-watch-data-integration", "live": current,
        "measurement_since": since,
        "measurements": [measurements(row["dataset_id"], since=since) for row in current],
        "evaluation_timing": evaluations,
        "history_versions": versions, "datasets": datasets, "legacy_inventory": inventory,
        "two_trading_days_verified": False, "clock_offset_verified": False,
        "mt4_deferred": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("seed", "report"))
    parser.add_argument("--since", type=int, default=0)
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()
    print(json.dumps(seed() if args.command == "seed" else report(args.since, args.compact), indent=2))
