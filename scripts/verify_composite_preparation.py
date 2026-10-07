"""Actual OANDA bounded composite catch-up in the isolated Ubuntu instance."""

import argparse
import copy
import json
import time
from pathlib import Path

from alerts.composite_definitions import first_use, save_mapping
from alerts.composite_inputs import rows
from alerts.composite_preparation import preparation_tick
from alerts.history_catalog import account_scope
from alerts.history_sources import HistorySources
from alerts.storage import (
    CompositeInputEvent,
    CompositePreparation,
    CompositeReadAttempt,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketCatalog,
    MarketDataset,
    MarketDemand,
    transaction,
)
from sqlalchemy import func, select


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default="artifacts/data-integration/composite-preparation-real.json")
    args = parser.parse_args()
    with transaction() as db:
        demand_before = db.scalar(select(func.count()).select_from(MarketDemand))
        entry = db.scalar(select(MarketCatalog).where(MarketCatalog.id.like("HC:%"),
            MarketCatalog.source == "oanda", MarketCatalog.symbol == "EUR_USD",
            MarketCatalog.available.is_(True)))
        assert entry and entry.metadata_json["history_account_scope"] == account_scope()
        dataset = db.scalar(select(MarketDataset).join(Instrument).where(
            MarketDataset.logical_symbol == "EURUSD", Instrument.calendar == "ny17",
            MarketDataset.identity["source"].as_string() == "oanda"))
        assert dataset
        proof = {"underlying": "EUR", "quote_currency": "USD", "historical_product": "spot_fx",
            "live_product": "spot_fx", "relationship": "same_product", "reviewed": True,
            "historical_evidence": "https://developer.oanda.com/rest-live-v20/instrument-ep/",
            "live_evidence": "https://developer.oanda.com/rest-live-v20/pricing-ep/",
            "rationale": "Explicit EUR_USD Bid to EUR_USD Bid mapping in the same scoped Practice account"}
        mapping = save_mapping(db, dataset.id, entry.id, proof)
        composite = first_use(db, dataset.id, mapping.id)
        composite_id, revision_id = composite.id, composite.active_revision_id
        revision = db.get(CompositeRevision, revision_id)
        seam, baseline = revision.seam, revision.history_version_id
        manifest = copy.deepcopy(db.get(HistoryVersion, baseline).manifest)
        cutoff = db.get(CompositePreparation, revision_id).cutoff
        assert 0 < cutoff - seam <= 3 * 86400000, "Verifier only authorizes <=3 days of actual supplier catch-up"
    adapter = HistorySources()
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            with transaction() as db:
                prep = db.get(CompositePreparation, revision_id)
                if prep.status == "queried":
                    break
                assert prep.status != "configuration_error", "supplier configuration rejected"
            preparation_tick(adapter, revision_id)
            time.sleep(1)
        else:
            raise RuntimeError("Actual bounded catch-up did not finish within 120 seconds")
    finally:
        adapter.close()
    with transaction() as db:
        prep = db.get(CompositePreparation, revision_id)
        observed = list(rows(db, revision_id, seam, cutoff, input_revision=prep.input_revision))
        attempts = list(db.scalars(select(CompositeReadAttempt).where(
            CompositeReadAttempt.revision_id == revision_id)))
        assert observed and all(row["complete"] and seam <= row["timestamp"] < cutoff for row in observed)
        assert any(row.accepted and row.read_kind == "supplier_request" for row in attempts)
        assert prep.cursor == cutoff and prep.confirmed_end <= cutoff
        assert db.get(HistoryVersion, baseline).manifest == manifest
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == demand_before
        assert db.scalar(select(CompositeInputEvent).where(CompositeInputEvent.revision_id == revision_id))
        frozen = db.get(CompositeRevision, revision_id)
        assert (frozen.seam, frozen.history_version_id) == (seam, baseline)
        result = {"environment": "Ubuntu Docker market-watch-three-layer", "supplier": "OANDA Practice actual M1",
            "composite_id": composite_id, "revision_id": revision_id, "baseline": baseline,
            "seam": seam, "fixed_cutoff": cutoff, "observed_minutes": len(observed),
            "confirmed_end": prep.confirmed_end, "input_revision": prep.input_revision,
            "queries": [{"start": row.start, "end": row.end, "result": row.result,
                "read_kind": row.read_kind, "observations": row.observations,
                "accepted": row.accepted} for row in attempts],
            "original_history_manifest_preserved": True, "no_demand_created": True,
            "scope": "internal catch-up; public charts and strategy readiness not verified", "passed": True}
    Path(args.report).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": True, "observed_minutes": len(observed), "queries": len(attempts)}))


if __name__ == "__main__":
    main()
