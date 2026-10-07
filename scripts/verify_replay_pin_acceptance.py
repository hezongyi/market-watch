"""Real Dukascopy reimport must leave existing published inputs/replays unchanged."""

import hashlib
import json
import time

from alerts.config import settings
from alerts.dukascopy_history import DukascopyHistory
from alerts.history_versions import create_version, import_page, snapshot_rows
from alerts.market_resources import lane
from alerts.storage import HistoryVersion, Replay, transaction
from sqlalchemy import select


def fingerprint(db, version_id):
    version = db.get(HistoryVersion, version_id)
    rows = list(snapshot_rows(db, version_id))
    replays = [{"id": run.id, "bars": run.bars,
                "warmup": hashlib.sha256(run.warmup_snapshot or b"").hexdigest(),
                "manifest": run.input_manifest, "days": run.days}
               for run in db.scalars(select(Replay).where(Replay.dataset_version == version_id))]
    digest = hashlib.sha256(json.dumps({"rows": rows, "manifest": version.manifest,
                                       "replays": replays}, sort_keys=True).encode()).hexdigest()
    return {"checksum": digest, "observed_minutes": len(rows), "replays": len(replays)}


def main():
    with transaction() as db:
        old = db.scalar(select(HistoryVersion).where(HistoryVersion.status == "published",
            HistoryVersion.end - HistoryVersion.start == 3600000,
            select(Replay.id).where(Replay.dataset_version == HistoryVersion.id).exists())
            .order_by(HistoryVersion.created_at))
        if not old:
            raise ValueError("A published bounded sample is required")
        version_id = old.id
        before = fingerprint(db, version_id)
        if before["replays"] < 1:
            raise ValueError("The sample must already be used by an actual acceptance replay")
        new = create_version(db, old.dataset_id, old.start, old.end)
    adapter = DukascopyHistory(proxy=settings.market_proxy or None)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            with lane("history"):
                import_page(adapter, version_id=new)
            with transaction() as db:
                if db.get(HistoryVersion, new).status == "published":
                    break
            time.sleep(1)
        else:
            raise RuntimeError("The bounded real reimport did not publish within 90 seconds")
    finally:
        adapter.close()
    with transaction() as db:
        after = fingerprint(db, version_id)
        manifest = db.get(HistoryVersion, new).manifest
    if before != after:
        raise RuntimeError("Reimport changed a published version or its pinned replay")
    print(json.dumps({"host": "Ubuntu local isolated Docker", "real_dukascopy_reimport": True,
        "original_version": version_id, "new_version": new, "new_observed_minutes": manifest["rows"],
        "before": before, "after": after, "pinned_inputs_unchanged": True}, indent=2))


if __name__ == "__main__":
    main()
