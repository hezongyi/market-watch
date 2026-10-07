"""Bounded real Ubuntu 10-symbol setup/observation and exact owned cleanup.

Setup keeps its explicit watches active for multichart/recovery verification.
Release cancels only IDs recorded in the private output, never all strategies.
Source prices are not altered, and outbound delivery must remain disabled.
"""

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "Ubuntu three-layer concurrency "
PAIRS = ("AUD_USD", "GBP_USD", "USD_JPY", "USD_CHF", "USD_CAD", "EUR_JPY", "EUR_GBP", "GBP_JPY")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("setup", "measure", "release"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--minutes", type=float, default=5)
    args = parser.parse_args()
    report = json.loads(args.output.read_text()) if args.output.exists() else {
        "environment": "Ubuntu isolated market-watch-three-layer", "passed": False,
        "started_at": int(time.time() * 1000), "records": [], "events": [], "failures": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.output.write_text(json.dumps(report, indent=2) + "\n")

    def emit(event, **facts):
        report["events"].append({"event": event, "at": int(time.time() * 1000), **facts})
        save()
        print(json.dumps({"event": event, **facts}), flush=True)

    with httpx.Client(base_url="http://127.0.0.1:16629", timeout=60, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads((ROOT / "artifacts/data-integration/three-layer-login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]

        def web(method, path, body=None):
            response = client.request(method, "/api/" + path, json=body)
            response.raise_for_status()
            return response.json()

        def wait_for(read, predicate, label, seconds=600):
            start, last_log = time.monotonic(), 0
            while time.monotonic() - start < seconds:
                value = read()
                if predicate(value):
                    return value, round(time.monotonic() - start, 3)
                if time.monotonic() - last_log > 30:
                    emit("waiting", label=label, elapsed_seconds=round(time.monotonic()-start, 1))
                    last_log = time.monotonic()
                time.sleep(2)
            raise AssertionError(label + " exceeded bounded wait")

        try:
            if args.action == "setup":
                setup = json.loads((ROOT / "artifacts/data-integration/cross-source-setup.json").read_text())
                for saved in setup["records"]:
                    if any(r.get("composite_id") == saved["composite_id"] for r in report["records"]):
                        continue
                    row = web("GET", "market-data/composites/" + saved["composite_id"])
                    assert row["calendar"] == "ny17"
                    report["records"].append({"symbol": saved["symbol"], "composite_id": row["id"],
                        "dataset_id": row["dataset_id"], "mapping_id": row["mapping"]["id"],
                        "revision_id": row["active_revision_id"], "source": "dukascopy"})
                start = web("GET", "market-data/date-boundary?date=2026-10-05&calendar=ny17")["start"]
                created = []
                for pair in PAIRS:
                    existing = next((r for r in report["records"] if r["symbol"] == pair.replace("_", "")
                        and r.get("initial_task_id")), None)
                    if existing:
                        created.append(existing)
                        continue
                    catalog = web("GET", "market-data/history-catalog?source=oanda&query=" + pair)
                    entry = next(row for row in catalog["items"] if row["provider_symbol"] == pair)
                    body = {"request_id": "concurrency10-create-" + str(report["started_at"]) + "-" + pair,
                        "dataset": {"source": "oanda", "logical_symbol": pair.replace("_", ""),
                            "provider_symbol": pair, "asset_class": "forex", "precision": entry["precision"],
                            "aggregation_calendar": "ny17", "catalog_id": entry["catalog_id"]},
                        "maintenance": {"target_start": start, "timeframes": ["M1", "H4", "D1"],
                            "frequency": "once", "timezone": "UTC", "daily_minute": 15, "overlap_minutes": 30}}
                    value = web("POST", "market-data/center/datasets", body)
                    row = {"symbol": pair.replace("_", ""), "dataset_id": value["dataset"]["id"],
                        "initial_task_id": value["task"]["id"], "source": "oanda", "catalog": entry,
                        "created_at": int(time.time()*1000)}
                    report["records"].append(row)
                    created.append(row)
                    save()
                emit("initial_history_queued", symbols=len(created))

                def histories():
                    return [web("GET", "market-data/versions/" + row["initial_task_id"]) for row in created]

                versions, elapsed = wait_for(histories, lambda rows: all(row["status"] == "published" for row in rows), "eight source M1 publications")
                report["initial_history_wait_seconds"] = elapsed
                for row, version in zip(created, versions):
                    assert version["manifest"]["identity"]["source"] == "oanda"
                    row["history_version_id"] = version["id"]
                    pair = row["catalog"]["provider_symbol"]
                    underlying, quote = pair.split("_")
                    proof = {"underlying": underlying, "quote_currency": quote, "historical_product": "spot_fx",
                        "live_product": "spot_fx", "relationship": "same_product", "reviewed": True,
                        "historical_evidence": "https://developer.oanda.com/rest-live-v20/instrument-ep/",
                        "live_evidence": "https://developer.oanda.com/rest-live-v20/pricing-ep/",
                        "rationale": "Same exact OANDA Practice instrument, account scope and original Bid M1; fixed historical and live windows, no product or price substitution."}
                    mapping = web("POST", "market-data/datasets/" + row["dataset_id"] + "/mappings",
                        {"catalog_id": row["catalog"]["catalog_id"], "match": proof})
                    row["mapping_id"] = mapping["id"]
                # Period publication is an independent gate, including M1.
                def artifacts():
                    return [web("GET", "market-data/versions/" + row["history_version_id"] + "/artifacts") for row in created]

                wait_for(artifacts, lambda pages: all({"M1", "H4", "D1"} <= {r["timeframe"] for r in page if r["status"] == "published"} for page in pages), "requested history periods")
                for row in created:
                    if row.get("watch_id"):
                        continue
                    candidates = web("GET", "market-data/series/search?kind=composite&source=oanda&calendar=ny17&query=" + row["symbol"])
                    candidate = next(r for r in candidates if r["dataset_id"] == row["dataset_id"] and r["mapping_id"] == row["mapping_id"])
                    result = web("POST", "watches", {"instrument_id": candidate["id"],
                        "series_kind": "composite", "name": PREFIX + row["symbol"],
                        "direction": "buy", "kind": "price", "timeframe": "M1", "level": "999999"})
                    row["watch_id"] = result["id"]
                    row["composite_id"] = result["market_identity"]["composite_id"]
                    row["revision_id"] = result["market_identity"]["composite_revision_id"]
                    save()
                for row in report["records"][:2]:
                    if row.get("watch_id"):
                        continue
                    result = web("POST", "watches", {"instrument_id": row["composite_id"], "series_kind": "composite",
                        "name": PREFIX + row["symbol"], "direction": "buy", "kind": "price", "timeframe": "M1", "level": "999999"})
                    row["watch_id"] = result["id"]
                    save()
                def watches():
                    by_id = {row["id"]: row for row in web("GET", "watches")}
                    return [by_id[row["watch_id"]] for row in report["records"]]

                ready, elapsed = wait_for(watches, lambda rows: all(r["health"] == "ready" for r in rows), "ten persistent M1 watches")
                report.update(watch_preparation_seconds=elapsed, initial_watches=ready)
                assert len({r["symbol"] for r in report["records"]}) == 10
                report["passed"] = True
                emit("ten_symbols_ready", seconds=elapsed)
            elif args.action == "measure":
                if not 1 <= args.minutes <= 60:
                    raise ValueError("Measurement requires 1-60 minutes")
                samples, latencies, read_times = [], [], []
                failure_baseline = len(report["failures"])
                baseline = int(time.time()*1000)
                seen, started = set(), time.monotonic()
                # Submit ten bounded refreshes while the persistent watches and
                # any browser charts keep their original fixed revisions.
                def refresh(row):
                    return web("POST", "market-data/datasets/" + row["dataset_id"] + "/tasks",
                        {"request_id": "concurrency10-refresh-" + str(baseline) + "-" + row["symbol"],
                            "kind": "recheck", "start": baseline//60000*60000-30*60000,
                            "end": (baseline-5000)//60000*60000})
                with ThreadPoolExecutor(max_workers=4) as pool:
                    refreshes = list(pool.map(refresh, report["records"]))
                report["concurrent_refresh_tasks"] = [r["id"] for r in refreshes]
                emit("concurrent_refresh_queued", tasks=len(refreshes))
                while time.monotonic() - started < args.minutes * 60:
                    sample_at = int(time.time()*1000)
                    try:
                        by_id = {r["id"]: r for r in web("GET", "watches")}
                        states = []
                        for row in report["records"]:
                            watch = by_id[row["watch_id"]]
                            assert watch["market_identity"]["composite_revision_id"] == row["revision_id"]
                            before = time.monotonic()
                            page = web("GET", f"market-data/composites/{row['composite_id']}/chart?timeframe=M1&count=3&revision_id={row['revision_id']}")
                            read_times.append(round((time.monotonic()-before)*1000,3))
                            confirmed = [b for b in page["bars"] if b["source_confirmed"] and b["time_closed"]]
                            if confirmed:
                                bar = confirmed[-1]
                                key = (row["symbol"], bar["end"])
                                if bar["end"] >= baseline and key not in seen:
                                    seen.add(key)
                                    latencies.append({"symbol": row["symbol"], "bar_end": bar["end"],
                                        "observed_at": int(time.time()*1000), "availability_delay_ms": int(time.time()*1000)-bar["end"]})
                            states.append({"symbol":row["symbol"],"health":watch["health"],
                                "reason":watch["health_reason"],"last_event":watch["state"].get("last_event"),
                                "confirmed_end":watch["runtime"].get("confirmed_end")})
                        samples.append({"at":sample_at,"duration_ms":int(time.time()*1000)-sample_at,"states":states})
                    except Exception as error:
                        report["failures"].append({"at":sample_at,"type":type(error).__name__})
                    time.sleep(max(.1, 3-(int(time.time()*1000)-sample_at)/1000))
                report["measurement"] = {"start":baseline,"end":int(time.time()*1000),"samples":samples,
                    "latencies":latencies,"cached_read_ms":read_times,"poll_seconds":3,
                    "meaning":"upper-bound HTTP confirmed composite availability after minute end; polling and aggregation included, not source clock offset or per-tick latency"}
                versions = [web("GET", "market-data/versions/" + r["id"]) for r in refreshes]
                report["refresh_results"] = versions
                assert all(v["status"] == "published" for v in versions)
                assert len(report["failures"]) == failure_baseline
                assert {r["symbol"] for r in latencies} == {r["symbol"] for r in report["records"]}
                report["measurement_passed"] = True
                emit("measurement_finished", minutes=args.minutes, samples=len(samples), new_confirmed_minutes=len(latencies))
            else:
                results = []
                by_id = {r["id"]:r for r in web("GET", "watches")}
                for row in report["records"]:
                    ident = row.get("watch_id")
                    if not ident:
                        continue
                    owned = by_id[ident]
                    assert owned["name"] == PREFIX + row["symbol"]
                    if owned["status"] == "active":
                        owned = web("POST", "watches/" + ident + "/cancel", {})
                    results.append({"id":ident,"status":owned["status"]})
                report["cleanup"] = results
                emit("released_owned_watches", watches=len(results))
        except Exception as error:
            report["failures"].append({"at":int(time.time()*1000),"type":type(error).__name__,"action":args.action})
            save()
            raise
        finally:
            save()


if __name__ == "__main__":
    main()
