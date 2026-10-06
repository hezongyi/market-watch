"""Run inside the isolated Ubuntu API container; print credential-free evidence."""

import argparse
import json
from datetime import datetime

from alerts.history_versions import create_version, version_report
from alerts.live_pricing import measurements, snapshots
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import legacy_inventory, register_dataset
from alerts.storage import HistoryVersion, MarketDataset, now_ms, transaction
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


def report(since=0):
    current = snapshots()
    with transaction() as db:
        versions = [version_report(db, ident) for ident in db.scalars(select(HistoryVersion.id))]
        inventory = legacy_inventory(db)
        datasets = [{"id": row.id, "instrument": row.instrument_id, "identity": row.identity}
                    for row in db.scalars(select(MarketDataset))]
    return {"observed_at": now_ms(), "host": "Ubuntu local isolated Docker",
        "project": "market-watch-data-integration", "live": current,
        "measurement_since": since,
        "measurements": [measurements(row["dataset_id"], since=since) for row in current],
        "history_versions": versions, "datasets": datasets, "legacy_inventory": inventory,
        "two_trading_days_verified": False, "clock_offset_verified": False,
        "mt4_deferred": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("seed", "report"))
    parser.add_argument("--since", type=int, default=0)
    args = parser.parse_args()
    print(json.dumps(seed() if args.command == "seed" else report(args.since), indent=2))
