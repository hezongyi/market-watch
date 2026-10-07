"""Run in this Ubuntu project's one-off backend container; preserve old histories."""

import json
import time

from alerts.history_derivation import derive_page, derive_version, restore_derivation_coverage_page
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.storage import HistoryVersion, MarketDataset, transaction
from sqlalchemy import select


def main():
    original_id = "ceb2577d-0c94-45b4-9952-d6c9c21a38dd"
    with transaction() as db:
        original = db.get(HistoryVersion, original_id)
        source = db.get(MarketDataset, original.dataset_id)
        identity = DatasetIdentity.model_validate({**source.identity, "calendar_version": "ny17-observed-v2"})
        inst = register_dataset(db, identity, logical_symbol="EURUSD", label="EURUSD Dukascopy BID original precision",
            calendar="ny17", precision=6, volume_kind=source.volume_kind, volume_unit=source.volume_unit)
        existing = db.scalar(select(HistoryVersion).where(HistoryVersion.dataset_id == identity.key,
            HistoryVersion.start == original.start, HistoryVersion.end == original.end))
        ident = existing.id if existing else derive_version(db, original_id, identity.key,
                                                           quarantine_reason="precision_overflow_verified")
    started = time.monotonic()
    while derive_page(ident):
        with transaction() as db:
            version = db.get(HistoryVersion, ident)
            if version.status != "deriving":
                break
            if version.manifest["provenance"]["copied_chunks"] % 100 == 0:
                print(json.dumps({"event": "derived_chunk_checkpoint", "version": ident,
                    "chunks": version.manifest["provenance"]["copied_chunks"], "cursor": version.cursor}), flush=True)
    after = original.start
    while True:
        restored = restore_derivation_coverage_page(ident, after)
        if restored is None:
            break
        after = restored
    with transaction() as db:
        new = db.get(HistoryVersion, ident)
        original = db.get(HistoryVersion, original_id)
        result = {"host": "Ubuntu local Docker", "original_version": original_id,
            "original_status": original.status, "original_cursor": original.cursor,
            "new_version": ident, "new_identity": identity.model_dump(), "new_instrument": inst.id,
            "new_precision": 6, "new_cursor": new.cursor, "new_status": new.status,
            "derivation_seconds": round(time.monotonic() - started, 3), "provenance": new.manifest["provenance"],
            "rounding": "none", "passed": new.cursor >= original.cursor}
    print(json.dumps({"event": "derivation_completed", **result}), flush=True)


if __name__ == "__main__":
    main()
