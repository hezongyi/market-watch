"""Read-only account stream probe; no persistent collector or notifications."""

import argparse
import hashlib
import json
import time
from pathlib import Path

from alerts.config import Settings
from alerts.market_contracts import DatasetIdentity, QuoteEvent, failed_request
from alerts.oanda_stream import OandaPractice


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=75)
    args = parser.parse_args()
    config = Settings(_env_file=args.env_file)
    adapter = OandaPractice(token=config.oanda_token, account_id=config.oanda_account_id,
                            proxy=config.oanda_proxy or config.market_proxy)
    evidence = {"environment": "Ubuntu read-only practice probe; no deployed instance",
                "stream_connections": 0, "prices": {}, "heartbeats": 0,
                "duration_seconds": 0, "sustained_two_day_gate": "not_tested"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        available = {item["name"]: item for item in adapter.catalog()}
        selected = {}
        for symbol in ("EUR_USD", "XAU_USD"):
            if symbol not in available:
                raise ValueError("Requested practice instrument is not available")
            selected[symbol] = DatasetIdentity(source="oanda", channel="v20", environment="practice",
                account_scope="sha256:" + hashlib.sha256(config.oanda_account_id.encode()).hexdigest(),
                provider_symbol=symbol, basis="bid", calendar_version="account-sample-unverified-v1")
        evidence["catalog"] = {symbol: {key: available[symbol].get(key) for key in
                                ("type", "displayPrecision", "pipLocation")} for symbol in selected}
        cutoff = (int(time.time() * 1000) - 5000) // 60000 * 60000
        evidence["m1"] = {}
        for symbol, identity in selected.items():
            batch = adapter.page(identity, cutoff - 5 * 60000, cutoff)
            evidence["m1"][symbol] = {"result": batch.result.model_dump(mode="json"),
                                       "rows": len(batch.rows),
                                       "last_start": batch.rows[-1].timestamp if batch.rows else None}
        evidence["stream_connections"] = 1
        for event in adapter.stream(selected, epoch=1):
            if isinstance(event, QuoteEvent):
                row = evidence["prices"].setdefault(event.identity.provider_symbol,
                    {"count": 0, "age_ms": [], "tradeable": False})
                row["count"] += 1
                row["age_ms"].append(event.received_at - event.source_time)
                row["tradeable"] = event.tradeable
                row["last_source_time"] = event.source_time
            else:
                evidence["heartbeats"] += 1
            elapsed = time.monotonic() - started
            evidence["duration_seconds"] = round(elapsed, 3)
            args.output.write_text(json.dumps(evidence, indent=2) + "\n")
            if elapsed >= args.seconds:
                break
        for row in evidence["prices"].values():
            samples = sorted(row.pop("age_ms"))
            row["age_ms_percentiles"] = {str(p): samples[min(len(samples) - 1, int((len(samples)-1) * p / 100))]
                                           for p in (50, 95, 99)}
        evidence["status"] = "probe_passed" if len(evidence["prices"]) == 2 else "incomplete"
    except Exception as error:
        evidence["status"] = "probe_failed"
        evidence["error"] = failed_request(error, observed_at=int(time.time() * 1000)).model_dump(mode="json")
    finally:
        adapter.close()
        args.output.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence))


if __name__ == "__main__":
    main()
