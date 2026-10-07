"""Actual Dukascopy fixed M1 -> OANDA confirmed M1, original prices/volume.

``setup`` uses the authenticated Ubuntu HTTP first-use entry. ``check`` and
``release`` run inside the same isolated API container against its database.
Only the named acceptance client is renewed/released; no rule is enabled.
"""

import argparse
import hashlib
import json
import time
from decimal import Decimal
from pathlib import Path

import httpx

CLIENT = "acceptance-cross-source"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("setup", "check", "release"))
    parser.add_argument("--input", type=Path, default=Path("artifacts/data-integration/cross-source-setup.json"))
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "action": args.action, "passed": False}
    if args.action == "setup":
        with httpx.Client(base_url="http://127.0.0.1:16629", trust_env=False, timeout=45) as client:
            login = client.post("/api/login", json=json.loads(Path("artifacts/data-integration/three-layer-login.json").read_text()))
            login.raise_for_status()
            client.headers["X-CSRF-Token"] = login.json()["csrf"]

            def request(method, path, body=None):
                response = client.request(method, "/api/market-data/" + path, json=body)
                response.raise_for_status()
                return response.json()

            records = []
            for symbol, underlying, product in (("EURUSD", "EUR", "spot_fx"), ("XAUUSD", "XAU", "spot_metal")):
                datasets = request("GET", f"center/datasets?query={symbol}&source=dukascopy&status=available")
                dataset = next(row for row in datasets["items"] if row["logical_symbol"] == symbol and row["aggregation_calendar"] == "ny17")
                catalog = request("GET", f"history-catalog?source=oanda&query={underlying}_USD")
                target = next(row for row in catalog["items"] if row["provider_symbol"] == underlying + "_USD")
                proof = {"underlying": underlying, "quote_currency": "USD", "historical_product": product,
                    "live_product": product, "relationship": "same_product" if underlying == "EUR" else "same_underlying_different_product",
                    "historical_evidence": "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
                    "live_evidence": "https://developer.oanda.com/rest-live-v20/instrument-ep/",
                    "reviewed": True, "rationale": "Explicit " + dataset["identity"]["provider_symbol"] + " historical Bid -> "
                        + target["provider_symbol"] + " scoped Practice Bid. Matching underlying and USD quotation only; "
                        "retain original prices and separate quantities, no execution/product equivalence or price adjustment."}
                mapping = request("POST", f"datasets/{dataset['id']}/mappings", {"catalog_id": target["catalog_id"], "match": proof})
                composite = request("POST", "composites/use", {"dataset_id": dataset["id"], "mapping_id": mapping["id"], "client": CLIENT})
                assert composite["historical_source"] == "dukascopy" and composite["live_source"] == "oanda"
                assert composite["revision"]["rules"]["seam"] == "latest-day-boundary-v1"
                assert composite["preparation"]["cutoff"] - composite["revision"]["seam"] < 3 * 86400000
                records.append({"symbol": symbol, "composite_id": composite["id"], "instrument_id": composite["instrument_id"],
                    "revision_id": composite["active_revision_id"], "dataset_id": dataset["id"], "mapping_id": mapping["id"],
                    "history_version_id": composite["revision"]["history_version_id"], "checksum": composite["revision"]["history_checksum"],
                    "seam": composite["revision"]["seam"], "cutoff": composite["preparation"]["cutoff"], "match": proof})
            start, renewed = time.monotonic(), time.monotonic()
            while time.monotonic() - start < 180:
                rows = [request("GET", f"composites/{record['composite_id']}") for record in records]
                if all(row["preparation"]["status"] == "queried" and row["preparation"]["confirmed_end"] >= record["cutoff"]
                       and all(p["status"] == "caught_up" for p in row["periods"]) for record, row in zip(records, rows)):
                    break
                assert not any(row["preparation"]["status"] == "configuration_error" for row in rows), rows
                if time.monotonic() - renewed > 30:
                    for record in records:
                        request("POST", "activity", {"client": CLIENT, "instrument": "MWC:" + record["composite_id"]})
                    renewed = time.monotonic()
                time.sleep(2)
            else:
                report.update(records=records, last_state=rows)
                args.output.write_text(json.dumps(report, indent=2) + "\n")
                raise AssertionError("bounded actual source preparation did not catch up")
            for record, row in zip(records, rows):
                record.update(input_revision=row["preparation"]["input_revision"],
                              validation_end=row["preparation"]["confirmed_end"])
            report.update(records=records, actual_worker_caught_up=True,
                          preparation_wait_seconds=round(time.monotonic()-start, 2), passed=True)
    else:
        from alerts.chart_data import FRAMES
        from alerts.composite_chart import chart_page
        from alerts.composite_inputs import rows as tail_rows
        from alerts.composite_series import period
        from alerts.history_versions import snapshot_rows
        from alerts.source_registry import collection_identity
        from alerts.storage import (
            CompositePreparation,
            CompositeRevision,
            HistoryVersion,
            MarketComposite,
            MarketDataset,
            MarketDemand,
            RealtimeMapping,
            now_ms,
            transaction,
        )

        setup = json.loads(args.input.read_text())
        records = []
        with transaction() as db:
            for saved in setup["records"]:
                composite = db.get(MarketComposite, saved["composite_id"])
                assert composite and composite.instrument_id == saved["instrument_id"]
                if args.action == "release":
                    ident = hashlib.sha256((CLIENT + "|" + composite.instrument_id).encode()).hexdigest()[:40]
                    demand = db.get(MarketDemand, ident)
                    if demand:
                        assert demand.instrument_id == composite.instrument_id
                        db.delete(demand)
                    records.append({"composite_id": composite.id, "released_lease": ident})
                    continue
                revision = db.get(CompositeRevision, saved["revision_id"])
                prep = db.get(CompositePreparation, revision.id)
                version = db.get(HistoryVersion, revision.history_version_id)
                mapping = db.get(RealtimeMapping, revision.mapping_id)
                target = db.get(MarketDataset, mapping.target_dataset_id)
                assert (revision.history_version_id, revision.seam, version.manifest["checksum"]) == (
                    saved["history_version_id"], saved["seam"], saved["checksum"])
                assert version.manifest["identity"]["source"] == "dukascopy" and target.identity["source"] == "oanda"
                assert version.end - version.start < 3 * 86400000
                historical = list(snapshot_rows(db, version.id, start=version.start, end=revision.seam))
                inputs = saved.get("input_revision", prep.input_revision)
                validation_end = saved.get("validation_end", saved["cutoff"])
                tail = list(tail_rows(db, revision.id, revision.seam, validation_end, input_revision=inputs))
                assert historical and tail
                assert all(row["timestamp"] < revision.seam for row in historical)
                assert all(row["timestamp"] >= revision.seam and row["complete"] for row in tail)
                historical_source = collection_identity(version.manifest["identity"]).key
                target_source = collection_identity(target.identity).key
                assert historical_source != target_source and all(row["source_id"] == target_source for row in tail)
                minutes = historical + tail
                # Independent OHLC oracle over exactly the pinned source M1;
                # does not call product aggregation or compare one page to itself.
                checks = []
                for frame in FRAMES:
                    grouped = {}
                    for minute in minutes:
                        grouped.setdefault(period(minute["timestamp"], frame, "ny17"), []).append(minute)
                    page = chart_page(db, composite.id, frame, revision_id=revision.id, input_revision=inputs,
                        before=validation_end, count=2000, now=now_ms())
                    by_start = {row["start"]: row for row in page["bars"]}
                    tested, mixed = 0, 0
                    for (left, right), members in grouped.items():
                        # The chart includes the entire bucket at this fixed
                        # input, so exclude right-edge buckets with later tail.
                        if right > validation_end or left not in by_start:
                            continue
                        bar = by_start[left]
                        expected = (Decimal(members[0]["open"]), max(Decimal(r["high"]) for r in members),
                                    min(Decimal(r["low"]) for r in members), Decimal(members[-1]["close"]))
                        assert tuple(Decimal(bar[key]) for key in ("open", "high", "low", "close")) == expected, (saved["symbol"], frame, left)
                        assert bar["observed_minutes"] == len(members)
                        if left < revision.seam < right:
                            assert bar["mixed_source"] and bar["seam_crossing"] and bar["volume"] is None
                            assert {segment["source_id"] for segment in bar["segments"]} == {historical_source, target_source}
                            mixed += 1
                        tested += 1
                    assert tested or frame in ("W1", "MN"), (saved["symbol"], frame, "no closed bucket witnesses")
                    if frame in ("W1", "MN"):
                        # Current cross-source week/month can be time-open;
                        # read only through cutoff at the saved input revision.
                        seam_bar = next(bar for bar in page["bars"] if bar["start"] <= revision.seam < bar["end"])
                        assert seam_bar["mixed_source"] and seam_bar["volume"] is None
                        assert seam_bar["volume_kind"] == "unavailable"
                        assert all(segment["observed_volume"] is not None for segment in seam_bar["segments"])
                        assert {segment["source_id"] for segment in seam_bar["segments"]} == {historical_source, target_source}
                        members = grouped[(seam_bar["start"], seam_bar["end"])]
                        expected = (Decimal(members[0]["open"]), max(Decimal(r["high"]) for r in members),
                                    min(Decimal(r["low"]) for r in members), Decimal(members[-1]["close"]))
                        assert tuple(Decimal(seam_bar[key]) for key in ("open", "high", "low", "close")) == expected
                        assert seam_bar["observed_minutes"] == len(members)
                        checks.append({"frame": frame, "closed_buckets": tested, "mixed_bucket": seam_bar})
                    else:
                        checks.append({"frame": frame, "closed_buckets": tested, "mixed_buckets": mixed})
                records.append({**saved, "input_revision": inputs, "historical_minutes": len(historical),
                    "target_minutes": len(tail), "checks": checks, "fixed_history_preserved": True})
        report.update(records=records, passed=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"action": args.action, "passed": report["passed"], "records": len(report["records"])}))


if __name__ == "__main__":
    main()
