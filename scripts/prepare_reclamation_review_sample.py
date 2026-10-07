"""Dedicated reclaimable identity from immutable real supplier content.

Run in Ubuntu API container. Reuses an existing actual sample; no supplier IO,
source demand or modification to its parent. Only this new acceptance identity
is marked paused/archived. Public HTTP config/period commands remain ordinary.
"""

import argparse
import json
import time
from pathlib import Path

import httpx
from alerts.history_derivation import derive_version
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.storage import HistoryVersion, MarketDataset, transaction
from sqlalchemy import select


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        print(json.dumps({"existing_owned_sample": True, **json.loads(args.output.read_text())}))
        return
    saved = json.loads(Path("artifacts/data-integration/cross-source-setup.json").read_text())
    parent_id = next(r["history_version_id"] for r in saved["records"] if r["symbol"] == "EURUSD")
    with transaction() as db:
        parent = db.get(HistoryVersion, parent_id)
        source = db.get(MarketDataset, parent.dataset_id)
        raw = DatasetIdentity.model_validate(source.identity).model_copy(
            update={"calendar_version": "acceptance-reclamation-review-utc0-v1"})
        existing = db.scalar(select(HistoryVersion).where(HistoryVersion.dataset_id == raw.key))
        if existing:
            raise ValueError("Existing owned identity without saved setup; inspect before modifying")
        register_dataset(db, raw, logical_symbol="EURUSD", label="EURUSD reclamation review acceptance",
            calendar="utc0", precision=5, asset_class="forex",
            volume_kind=source.volume_kind, volume_unit=source.volume_unit)
        ident = derive_version(db, parent.id, raw.key)
        report = {"environment": "Ubuntu isolated market-watch-three-layer", "dataset_id": raw.key,
            "version_id": ident, "parent_version_id": parent.id, "parent_checksum": parent.manifest["checksum"],
            "start": parent.start, "end": parent.end, "passed": False}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=60, trust_env=False) as client:
        response = client.post("/api/login", json=json.loads(Path(
            "artifacts/data-integration/three-layer-login.json").read_text()))
        response.raise_for_status()
        client.headers["X-CSRF-Token"] = response.json()["csrf"]

        def web(method, route, body=None):
            response = client.request(method, "/api/market-data/" + route, json=body)
            response.raise_for_status()
            return response.json()

        for _ in range(300):
            if web("GET", "versions/" + ident)["status"] == "published":
                break
            time.sleep(1)
        else:
            raise AssertionError("Dedicated derivation did not publish")
        web("POST", "datasets/" + raw.key + "/maintenance", {"target_start": report["start"],
            "frequency": "once", "timeframes": ["M1", "H4"], "overlap_minutes": 30})
        web("POST", "datasets/" + raw.key + "/maintenance/control", {"action": "pause"})
        web("POST", "datasets/" + raw.key + "/maintenance/control", {"action": "archive"})
        for _ in range(120):
            periods = web("GET", "versions/" + ident + "/artifacts")
            if len(periods) >= 2 and all(r["status"] == "published" for r in periods):
                break
            time.sleep(1)
        else:
            raise AssertionError("Dedicated periods did not publish")
        impact = web("GET", "datasets/" + raw.key + "/references")
        assert impact["can_reclaim"] and len(impact["impact"]["versions"]) == 1
        assert web("GET", "versions/" + parent_id)["manifest"]["checksum"] == report["parent_checksum"]
        report.update(passed=True, reused_actual_supplier_content=True, initial_impact=impact)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": True, "dataset_id": raw.key, "version_id": ident}))


if __name__ == "__main__":
    main()
