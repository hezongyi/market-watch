"""Actual supplier M1 publication across DST and month boundaries.

Run inside the isolated API container. Dedicated, disabled acceptance metadata
identities prevent old bounded samples from becoming normal dataset baselines.
No session closures, prices, stream demand or notifications are invented.
Reference buckets use datetime/zoneinfo, never application aggregation helpers.
"""

import argparse
import json
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.storage import HistoryChunk, HistoryReadAttempt, MarketDemand, transaction
from sqlalchemy import func, select

NY = ZoneInfo("America/New_York")
WINDOWS = {
    "spring": ("2026-03-05T22:00:00+00:00", "2026-03-10T21:00:00+00:00"),
    "autumn": ("2025-10-30T21:00:00+00:00", "2025-11-04T22:00:00+00:00"),
    "month": ("2026-08-30T21:00:00+00:00", "2026-09-02T21:00:00+00:00"),
}
FRAMES = ("M1", "H4", "D1", "W1", "MN")


def millis(value):
    return int(value.timestamp() * 1000)


def reference_bucket(stamp, frame, phase):
    moment = datetime.fromtimestamp(stamp / 1000, UTC)
    zone, hour = (NY, 17) if phase == "ny17" else (UTC, 0)
    local = moment.astimezone(zone)
    day = local.date() - timedelta(days=int(local.hour < hour))

    def boundary(value):
        return datetime(value.year, value.month, value.day, hour, tzinfo=zone).astimezone(UTC)

    if frame in ("W1", "MN"):
        label = day + timedelta(days=int(phase == "ny17"))
        first = label - timedelta(days=label.weekday()) if frame == "W1" else label.replace(day=1)
        last = first + timedelta(days=7) if frame == "W1" else (first.replace(day=28) + timedelta(days=4)).replace(day=1)
        shift = timedelta(days=int(phase == "ny17"))
        return millis(boundary(first - shift)), millis(boundary(last - shift))
    left, right = boundary(day), boundary(day + timedelta(days=1))
    if frame == "H4":
        left += timedelta(seconds=int((moment - left).total_seconds() // 14400) * 14400)
        right = min(left + timedelta(hours=4), right)
    return millis(left), millis(right)


def check_prices(minutes, bars, frame, phase):
    grouped = {}
    for row in minutes:
        pair = reference_bucket(row["start"], frame, phase)
        grouped.setdefault(pair, []).append(row)
    assert len(bars) == len(grouped), (frame, phase, len(bars), len(grouped))
    checked = []
    for bar in bars:
        pair = (bar["start"], bar["end"])
        members = grouped[pair]
        expected = (Decimal(members[0]["open"]), max(Decimal(m["high"]) for m in members),
            min(Decimal(m["low"]) for m in members), Decimal(members[-1]["close"]))
        assert tuple(Decimal(bar[k]) for k in ("open", "high", "low", "close")) == expected
        assert bar["observed_minutes"] == len(members) and bar["source_confirmed"]
        assert bar["complete"] == (bar["time_closed"] and bar["coverage_complete"] and bar["source_confirmed"])
        checked.append({"start": pair[0], "end": pair[1], "observed_minutes": len(members),
            "coverage_complete": bar["coverage_complete"], "complete": bar["complete"]})
    return {"frame": frame, "phase": phase, "buckets": checked, "independent_ohlc_matches": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = json.loads(args.output.read_text()) if args.output.exists() else {
        "environment": "Ubuntu isolated market-watch-three-layer", "passed": False,
        "records": [], "failures": []}

    def save():
        args.output.write_text(json.dumps(report, indent=2) + "\n")

    with transaction() as db:
        demand_before = db.scalar(select(func.count()).select_from(MarketDemand))
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=60, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(Path(
            "artifacts/data-integration/three-layer-login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]

        def web(method, route, body=None):
            response = client.request(method, "/api/market-data/" + route, json=body)
            response.raise_for_status()
            return response.json()

        def wait(read, accept, label):
            started, logged = time.monotonic(), 0
            while time.monotonic() - started < 1200:
                value = read()
                if accept(value):
                    return value
                if time.monotonic() - logged > 30:
                    print(json.dumps({"waiting": label, "seconds": round(time.monotonic()-started)}), flush=True)
                    logged = time.monotonic()
                time.sleep(2)
            raise AssertionError("Bounded calendar sample wait exceeded: " + label)

        try:
            # Queue public version commands on explicitly isolated metadata
            # identities. The normal history-worker still downloads/publishes.
            for source in ("dukascopy", "oanda"):
                for symbol, asset, precision in (("EURUSD", "forex", 5), ("XAUUSD", "metal", 3)):
                    for name, bounds in WINDOWS.items():
                        found = next((r for r in report["records"] if
                            (r["source"], r["symbol"], r["window"]) == (source, symbol, name)), None)
                        if found:
                            continue
                        expected_symbol = symbol[:3] + ("/" if source == "dukascopy" else "_") + symbol[3:]
                        catalog = web("GET", f"history-catalog?source={source}&query={expected_symbol}&page_size=100")
                        assert any(r["provider_symbol"] == expected_symbol for r in catalog["items"])
                        if source == "oanda":
                            from alerts.history_catalog import account_scope
                            scope = account_scope()
                        else:
                            scope = "public"
                        identity = DatasetIdentity(source=source, provider_symbol=expected_symbol,
                            channel="python" if source == "dukascopy" else "v20",
                            environment="historical" if source == "dukascopy" else "practice",
                            account_scope=scope, basis="bid", calendar_version="acceptance-calendar-" + name + "-ny17-v1")
                        with transaction() as db:
                            register_dataset(db, identity, logical_symbol=symbol,
                                label=symbol + " calendar acceptance " + name, calendar="ny17",
                                precision=precision, asset_class=asset,
                                volume_kind="quantity" if source == "dukascopy" else "price_count",
                                volume_unit="source_quantity" if source == "dukascopy" else "quotes")
                        start, end = [millis(datetime.fromisoformat(b)) for b in bounds]
                        # Recover an interrupted setup before repeating a create.
                        versions = web("GET", "versions?dataset_id=" + identity.key)
                        version = next((v for v in versions if (v["start"], v["end"]) == (start, end)), None)
                        if version is None:
                            version = web("POST", "versions", {"dataset_id": identity.key, "start": start, "end": end})
                        record = {"source": source, "symbol": symbol, "window": name,
                            "dataset_id": identity.key, "version_id": version["id"], "start": start, "end": end}
                        report["records"].append(record)
                        save()
            for record in report["records"]:
                if record.get("passed"):
                    continue
                version_id = record["version_id"]
                published = wait(lambda: web("GET", "versions/" + version_id),
                    lambda v: v["status"] == "published", version_id)
                original_manifest = published["manifest"]
                web("POST", "versions/" + version_id + "/artifacts", {"timeframes": FRAMES})
                wait(lambda: web("GET", "versions/" + version_id + "/artifacts"),
                    lambda a: len(a) == len(FRAMES) and all(r["status"] == "published" for r in a), version_id + " periods")
                minutes = web("GET", f"versions/{version_id}/bars?timeframe=M1&limit=20000")["bars"]
                assert minutes and len(minutes) == original_manifest["rows"]
                record["checks"] = []
                for frame in FRAMES[1:]:
                    bars = web("GET", f"versions/{version_id}/bars?timeframe={frame}&limit=20000")["bars"]
                    record["checks"].append(check_prices(minutes, bars, frame, "ny17"))
                    if frame == "D1" and record["window"] in ("spring", "autumn"):
                        assert {datetime.fromtimestamp(b["start"] / 1000, UTC).hour for b in bars} == {21, 22}
                    if frame == "MN" and record["window"] == "month":
                        assert len(bars) == 2
                    if frame == "W1" and record["window"] in ("spring", "autumn"):
                        expected_hours = 167 if record["window"] == "spring" else 169
                        assert any(b["end"] - b["start"] == expected_hours * 3600000 for b in bars)
                derived = web("POST", "datasets/" + record["dataset_id"] + "/aggregation",
                    {"aggregation_calendar": "utc0", "version_id": version_id})
                derived_id = derived["version"]["id"]
                record["utc_version_id"] = derived_id
                save()
                wait(lambda: web("GET", "versions/" + derived_id), lambda v: v["status"] == "published", derived_id)
                web("POST", "versions/" + derived_id + "/artifacts", {"timeframes": FRAMES})
                wait(lambda: web("GET", "versions/" + derived_id + "/artifacts"),
                    lambda a: len(a) == len(FRAMES) and all(r["status"] == "published" for r in a), derived_id + " periods")
                utc_minutes = web("GET", f"versions/{derived_id}/bars?timeframe=M1&limit=20000")["bars"]
                fields = ("start", "end", "open", "high", "low", "close", "volume", "source_confirmed")
                assert [tuple(r[k] for k in fields) for r in minutes] == [tuple(r[k] for k in fields) for r in utc_minutes]
                for frame in FRAMES[1:]:
                    bars = web("GET", f"versions/{derived_id}/bars?timeframe={frame}&limit=20000")["bars"]
                    record["checks"].append(check_prices(utc_minutes, bars, frame, "utc0"))
                with transaction() as db:
                    def chunks(ident):
                        return [(c.checksum, c.content_id) for c in db.scalars(select(HistoryChunk).where(
                            HistoryChunk.version_id == ident).order_by(HistoryChunk.start))]
                    assert chunks(version_id) == chunks(derived_id)
                    assert db.scalar(select(HistoryReadAttempt.id).where(HistoryReadAttempt.version_id == derived_id).limit(1)) is None
                assert web("GET", "versions/" + version_id)["manifest"] == original_manifest
                record.update(passed=True, m1_rows=len(minutes), unknown_minutes=original_manifest["unknown_minutes"],
                    shared_original_content=True, derived_supplier_downloads=0, original_manifest_unchanged=True)
                save()
                print(json.dumps({"passed": True, "source": record["source"], "symbol": record["symbol"],
                    "window": record["window"], "m1_rows": len(minutes)}), flush=True)
            with transaction() as db:
                assert db.scalar(select(func.count()).select_from(MarketDemand)) == demand_before
            report.update(passed=True, no_chart_or_stream_demand_created=True,
                meaning="Actual bounded supplier observations and published periods; missing minutes remain unknown. DST weekend contains no guaranteed market observations, not a complete source-session validation.")
        except Exception as error:
            report["failures"].append({"type": type(error).__name__})
            raise
        finally:
            save()


if __name__ == "__main__":
    main()
