"""Actual Ubuntu NY17/UTC0 revisions with fixed watches and original supplier M1.

Run inside the isolated API container. Test-owned watches are cancelled and
each changed composite is explicitly returned to its previous NY17 rules.
No supplier prices, notification delivery or other runtime projects are changed.
"""

import argparse
import json
import time
from decimal import Decimal
from pathlib import Path

import httpx
from alerts.composite_definitions import ProductMatch
from alerts.composite_inputs import rows as tail_rows
from alerts.history_versions import snapshot_rows
from alerts.storage import HistoryChunk, HistoryReadAttempt, HistoryVersion, transaction
from sqlalchemy import select


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "passed": False,
        "records": [], "cleanup": []}
    owned, switched = [], []
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=60, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(Path(
            "artifacts/data-integration/three-layer-login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]

        def web(method, route, body=None):
            response = client.request(method, "/api/" + route, json=body)
            response.raise_for_status()
            return response.json()

        def wait(read, accept, label):
            start = time.monotonic()
            while time.monotonic() - start < 300:
                value = read()
                if accept(value):
                    return value, round(time.monotonic() - start, 3)
                time.sleep(2)
            raise AssertionError(f"{label} did not finish in 300s: {value}")

        def prepare(ident, original, version_id, mapping_id, seam, suffix):
            route = "market-data/composites/" + ident
            body = {"request_id": args.request_id + ":" + suffix,
                "expected_revision_id": original, "history_version_id": version_id,
                "mapping_id": mapping_id, "seam": seam,
                "reason": "Ubuntu actual calendar acceptance: explicit fixed revision; no strategy migration"}
            created = web("POST", route + "/revisions", body)
            assert web("POST", route + "/revisions", body)["id"] == created["id"]
            ready, elapsed = wait(lambda: web("GET", route + "/revisions/" + created["id"]),
                lambda row: row["preparation"]["ready"], suffix)
            assert web("GET", route)["active_revision_id"] == original
            activation = {"request_id": args.request_id + ":activate:" + suffix,
                "expected_revision_id": original}
            active = web("POST", route + "/revisions/" + ready["id"] + "/activate", activation)
            assert web("POST", route + "/revisions/" + ready["id"] + "/activate", activation) == active
            return active, elapsed

        try:
            setup = json.loads(Path("artifacts/data-integration/cross-source-setup.json").read_text())
            for saved in setup["records"]:
                ident, symbol = saved["composite_id"], saved["symbol"]
                route = "market-data/composites/" + ident
                original = web("GET", route)
                assert original["calendar"] == "ny17" and original["historical_source"] == "dukascopy"
                record = {"symbol": symbol, "composite_id": ident, "original": original}
                report["records"].append(record)
                old_revision = original["active_revision_id"]
                old_input = original["preparation"]["input_revision"]
                old_before = original["preparation"]["confirmed_end"]
                old_query = route + f"/chart?timeframe=H4&count=40&revision_id={old_revision}&input_revision={old_input}&before={old_before}"
                old_page = web("GET", old_query)
                watch = web("POST", "watches", {"instrument_id": ident, "series_kind": "composite",
                    "name": "calendar acceptance " + symbol, "direction": "buy", "kind": "price",
                    "timeframe": "M1", "level": "999999"})
                owned.append(watch["id"])
                assert watch["market_identity"]["composite_revision_id"] == old_revision
                version_id = original["revision"]["history_version_id"]
                derived = web("POST", f"market-data/datasets/{original['dataset_id']}/aggregation",
                    {"aggregation_calendar": "utc0", "version_id": version_id})
                record["derivation"] = derived
                derived_id = derived["version"]["id"]
                published, elapsed = wait(lambda: web("GET", "market-data/versions/" + derived_id),
                    lambda row: row["status"] == "published", symbol + " derivation")
                record["derivation_seconds"] = elapsed
                with transaction() as db:
                    parent = db.get(HistoryVersion, version_id)
                    copied = db.get(HistoryVersion, derived_id)
                    copied_start = copied.start
                    before_rows = list(snapshot_rows(db, version_id, start=parent.start, end=parent.end))
                    after_rows = list(snapshot_rows(db, derived_id, start=copied.start, end=copied.end))
                    assert before_rows == after_rows and before_rows
                    source_chunks = list(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == version_id).order_by(HistoryChunk.start)))
                    derived_chunks = list(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == derived_id).order_by(HistoryChunk.start)))
                    assert [(c.checksum, c.content_id) for c in source_chunks] == [(c.checksum, c.content_id) for c in derived_chunks]
                    assert db.scalar(select(HistoryReadAttempt.id).where(HistoryReadAttempt.version_id == derived_id).limit(1)) is None
                    record["m1_reuse"] = {"minutes": len(before_rows), "chunks": len(source_chunks),
                        "same_rows_and_shared_content": True, "no_derived_supplier_request": True}
                assert published["manifest"]["provenance"]["derived_from_version"] == version_id
                web("POST", "market-data/versions/" + derived_id + "/artifacts",
                    {"timeframes": ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]})
                _, elapsed = wait(lambda: web("GET", "market-data/versions/" + derived_id + "/artifacts"),
                    lambda rows: len(rows) == 9 and all(row["status"] == "published" for row in rows),
                    symbol + " derived period publication")
                record["derived_period_seconds"] = elapsed
                # Economic match is exactly the already reviewed source/product;
                # only the self-built calendar identity has changed.
                proof = {key: original["mapping"]["match"][key] for key in ProductMatch.model_fields}
                target_symbol = original["mapping"]["target_identity"]["provider_symbol"]
                catalog = web("GET", "market-data/history-catalog?source=oanda&query=" + target_symbol)
                target = next(row for row in catalog["items"] if row["provider_symbol"] == target_symbol)
                mapping = web("POST", f"market-data/datasets/{derived['dataset']['id']}/mappings",
                    {"catalog_id": target["catalog_id"], "match": proof})
                options = web("GET", route + "/revision-options")
                selected = next(row for row in options["items"] if row["version_id"] == derived_id)
                switched.append((ident, original))
                active, elapsed = prepare(ident, old_revision, derived_id, mapping["id"],
                    selected["recommended_seam"], symbol + ":utc")
                record.update(utc_revision=active, preparation_seconds=elapsed)
                current = web("GET", route)
                assert current["calendar"] == "utc0" and current["mapping"]["id"] == mapping["id"]
                meta = web("GET", "market-data/series/search?kind=composite&query=" + symbol + "&calendar=utc0")
                found = next(row for row in meta if row["id"] == ident)
                assert found["mapping_id"] == mapping["id"] and found["dataset_id"] == derived["dataset"]["id"]
                pinned = next(row for row in web("GET", "watches") if row["id"] == watch["id"])
                assert pinned["market_identity"]["composite_revision_id"] == old_revision
                assert web("GET", old_query)["bars"] == old_page["bars"]
                cutoff, inputs = active["preparation"]["cutoff"], active["preparation"]["input_revision"]
                seam = active["seam"]
                with transaction() as db:
                    history = list(snapshot_rows(db, derived_id, start=copied_start, end=seam))
                    tail = list(tail_rows(db, active["id"], seam, cutoff, input_revision=inputs))
                minutes = history + tail
                assert history and tail
                checks = []
                for frame, interval in (("H4", 14400000), ("D1", 86400000)):
                    grouped = {}
                    for minute in minutes:
                        grouped.setdefault(minute["timestamp"] // interval * interval, []).append(minute)
                    page = web("GET", route + f"/chart?timeframe={frame}&count=100&revision_id={active['id']}&input_revision={inputs}&before={cutoff}")
                    tested = 0
                    for bar in page["bars"]:
                        members = grouped.get(bar["start"], [])
                        if not members or bar["end"] > cutoff:
                            continue
                        expected = (Decimal(members[0]["open"]), max(Decimal(m["high"]) for m in members),
                            min(Decimal(m["low"]) for m in members), Decimal(members[-1]["close"]))
                        assert tuple(Decimal(bar[k]) for k in ("open", "high", "low", "close")) == expected
                        assert bar["start"] % interval == 0 and bar["end"] == bar["start"] + interval
                        assert bar["observed_minutes"] == len(members)
                        tested += 1
                    assert tested, (symbol, frame, "no real bucket witness")
                    checks.append({"frame": frame, "buckets": tested})
                record.update(utc_ohlc_checks=checks, old_pinned_chart_unchanged=True, fixed_watch_unchanged=True)
                print(json.dumps({"progress": symbol, "prepared_seconds": elapsed}), flush=True)
            report["passed"] = True
        finally:
            try:
                for ident, original in reversed(switched):
                    current = web("GET", "market-data/composites/" + ident)
                    if current["active_revision_id"] == original["active_revision_id"]:
                        continue
                    restored, elapsed = prepare(ident, current["active_revision_id"],
                        original["revision"]["history_version_id"], original["mapping"]["id"],
                        original["revision"]["seam"], original["logical_symbol"] + ":restore")
                    assert restored["rules"]["aggregation_calendar"] == "ny17"
                    report["cleanup"].append({"composite_id": ident, "ny17_revision": restored["id"], "seconds": elapsed})
            finally:
                for ident in owned:
                    result = web("POST", "watches/" + ident + "/cancel", {})
                    report["cleanup"].append({"watch_id": ident, "status": result["status"]})
                print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
