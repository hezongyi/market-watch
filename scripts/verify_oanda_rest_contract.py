"""Read-only contract verification in the task's isolated Ubuntu Docker runner.

Uses real two-second latest batches, then checks complete M1 Decimal OHLCV
against the existing same-account confirmation adapter. No market writes,
notifications, pricing, streams or raw credentials appear in the report.
"""

import argparse
import collections
import json
import math
import statistics
import time
from decimal import Decimal
from pathlib import Path

from alerts.config import settings
from alerts.market_contracts import DatasetIdentity
from alerts.oanda_rest_batch import CandleSpec, OandaRestBatch

SYMBOLS = ("EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "NZD_USD",
           "USD_CAD", "EUR_JPY", "GBP_JPY", "EUR_GBP", "AUD_JPY", "XAU_USD")


def stats(values):
    ordered = sorted(values)
    return {"count": len(ordered), "median": statistics.median(ordered) if ordered else None,
            "p95": ordered[math.ceil(len(ordered) * .95) - 1] if ordered else None,
            "max": max(ordered) if ordered else None}


def main():
    import hashlib

    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--output", type=Path, default=Path("/evidence/contract.json"))
    args = parser.parse_args()
    if not 60 <= args.seconds <= 900:
        parser.error("Use a bounded 60–900 second observation")
    scope = "sha256:" + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
    identities = {symbol: DatasetIdentity(source="oanda", channel="v20", environment="practice",
        account_scope=scope, provider_symbol=symbol, basis="bid", calendar_version=settings.oanda_calendar_version)
        for symbol in SYMBOLS}
    specs = [CandleSpec.from_dataset(identity) for identity in identities.values()]
    adapter = OandaRestBatch(token=settings.oanda_token, account_id=settings.oanda_account_id,
        proxy=settings.oanda_proxy or settings.market_proxy)
    records, confirmed, confirmations = [], {}, {}
    start = time.monotonic()
    start_ms = int(time.time() * 1000)
    tick, skipped = start, 0
    try:
        while time.monotonic() - start < args.seconds:
            if tick > time.monotonic():
                time.sleep(tick - time.monotonic())
            if time.monotonic() - start >= args.seconds:
                break
            before = time.monotonic()
            value = adapter.latest(specs, generation=1, sequence=len(records) + 1,
                demand_revision="contract-verification", deadline=before + 7)
            record = {"requested_at": value.requested_at, "received_at": value.received_at,
                "result": value.result.status, "elapsed_ms": round((time.monotonic() - before) * 1000, 3),
                "series": {row.spec.provider_symbol: row.result.status for row in value.series},
                "current": sum(value.current_observation(row.spec, committed_at=value.received_at,
                    recovery="pending") is not None for row in value.series)}
            records.append(record)
            for row in value.series:
                for candle in row.candles:
                    if candle.complete:
                        key = row.spec.provider_symbol, candle.start
                        confirmed[key] = candle
                        if candle.end >= start_ms:
                            confirmations.setdefault(key, value.received_at - candle.end)
            tick += 2
            if tick < time.monotonic():
                missed = math.ceil((time.monotonic() - tick) / 2)
                skipped += missed
                tick += missed * 2
            if len(records) % 15 == 0:
                print(json.dumps({"stage": "latest", "requests": len(records),
                                  "elapsed_seconds": round(time.monotonic() - start, 1)}), flush=True)
        comparisons = []
        # Compare only closed minutes the old path will admit; the latest path
        # has already recorded its first confirmation without the old 5s wait.
        for (symbol, at), candle in sorted(confirmed.items()):
            if candle.end > adapter.clock() - 5000:
                continue
            old = adapter.page(identities[symbol], at, candle.end)
            row = next((row for row in old.rows if row.timestamp == at), None)
            equal = row is not None and all(
                (Decimal(getattr(candle, key)) if getattr(candle, key) is not None else None) ==
                (Decimal(getattr(row, key)) if getattr(row, key) is not None else None)
                for key in ("open", "high", "low", "close", "volume"))
            comparisons.append({"symbol": symbol, "start": at, "end": candle.end,
                "result": old.result.status, "matched_decimal_ohlcv": equal})
            if not equal:
                print(json.dumps({"stage": "comparison", "symbol": symbol, "matched": False}), flush=True)
        covered = {row["symbol"] for row in comparisons if row["matched_decimal_ohlcv"]}
        all_good = (all(record["result"] == "data" and all(status == "data" for status in record["series"].values())
                        for record in records) and covered == set(SYMBOLS)
                    and all(row["matched_decimal_ohlcv"] for row in comparisons))
        report = {"contract_version": 1, "host": "Ubuntu local Docker", "production_changed": False,
            "scope": "adapter contracts only; not end-to-end system acceptance", "interval_seconds": 2,
            "duration_seconds": args.seconds, "requests": len(records), "skipped_ticks": skipped,
            "statuses": dict(collections.Counter(record["result"] for record in records)),
            "request_start_gap_ms": stats([right["requested_at"] - left["requested_at"]
                for left, right in zip(records, records[1:])]),
            "request_ms": stats([record["elapsed_ms"] for record in records]),
            "first_confirmation_delay_ms": stats(list(confirmations.values())),
            "spec_identities": [spec.identity.model_dump() for spec in specs],
            "comparison_count": len(comparisons), "comparisons": comparisons,
            "samples": records, "passed": all_good}
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: report[key] for key in ("requests", "statuses", "comparison_count", "passed")}), flush=True)
        return 0 if all_good else 1
    finally:
        adapter.close()


if __name__ == "__main__":
    raise SystemExit(main())
