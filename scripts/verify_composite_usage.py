"""Explicit composite chart demands and actual isolated pricing-worker lifecycle."""

import argparse
import hashlib
import json
from pathlib import Path

from alerts.config import settings
from alerts.history_catalog import account_scope
from alerts.live_pricing import account_key, desired_datasets
from alerts.market_data import renew_demand
from alerts.storage import (
    CompositePreparation,
    Instrument,
    LiveState,
    MarketComposite,
    MarketDemand,
    PricingOwner,
    RealtimeMapping,
    now_ms,
    transaction,
)
from sqlalchemy import select

CLIENTS = ("acceptance-composite-chart-1", "acceptance-composite-chart-2")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("idle", "start", "connected", "release", "released"))
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    with transaction() as db:
        composite, mapping = db.execute(select(MarketComposite, RealtimeMapping).join(
            RealtimeMapping, MarketComposite.mapping_id == RealtimeMapping.id).where(
                RealtimeMapping.match["underlying"].as_string() == "EUR")).first()
        assert mapping.match["target_identity"]["account_scope"] == account_scope()
        ticker = composite.instrument_id
        keys = [hashlib.sha256((client + "|" + ticker).encode()).hexdigest()[:40] for client in CLIENTS]
        if args.action == "start":
            for client in CLIENTS:
                renew_demand(db, client, db.get(Instrument, ticker))
            assert all(db.get(MarketDemand, key) for key in keys)
        if args.action == "release":
            for key in keys:
                demand = db.get(MarketDemand, key)
                if demand:
                    db.delete(demand)
        state = db.get(LiveState, mapping.target_dataset_id)
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
        prep = db.get(CompositePreparation, composite.active_revision_id)
        if args.action == "idle":
            assert not owner or not owner.token or owner.expires <= now_ms()
        if args.action == "connected":
            assert owner and owner.token and owner.expires > now_ms()
            assert state and state.ready and state.quote and state.connection == "connected"
            assert state.quote["tradeable"] and state.confirmed_end > prep.cutoff
            assert prep.confirmed_end > prep.cutoff
        if args.action == "released":
            assert owner and owner.token is None and owner.error is None and owner.failures == 0
            assert state.connection == "inactive" and not state.ready and state.error is None
            assert all(db.get(MarketDemand, key) is None for key in keys)
        result = {"environment": "Ubuntu market-watch-three-layer", "action": args.action,
            "composite": composite.id, "target_dataset": mapping.target_dataset_id,
            "owner_active": bool(owner and owner.token and owner.expires > now_ms()),
            "connection": state.connection if state else None,
            "recovery_ready": state.ready if state else False,
            "quote_present": bool(state and state.quote),
            "source_confirmed_end": state.confirmed_end if state else None,
            "composite_confirmed_end": prep.confirmed_end, "fixed_cutoff": prep.cutoff,
            "input_revision": prep.input_revision, "passed": True}
    desired = desired_datasets(settings.oanda_account_id)
    if args.action in ("idle", "release", "released"):
        assert not desired
    else:
        assert set(desired) == {"EUR_USD"}
    result["desired_symbols"] = sorted(desired)
    Path(args.report).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"action": args.action, "passed": True, "owner_active": result["owner_active"],
                      "connection": result["connection"]}))


if __name__ == "__main__":
    main()
