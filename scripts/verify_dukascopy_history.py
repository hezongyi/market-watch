"""Finite read-only SDK acceptance samples; never logs proxy or credentials."""

import argparse
import hashlib
import json
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from alerts.config import Settings
from alerts.dukascopy_history import DukascopyHistory
from alerts.market_contracts import DatasetIdentity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = Settings(_env_file=args.env_file)
    cases = {
        "near_month": ("2026-09-01T12:00:00Z", "2026-09-01T12:15:00Z"),
        "earliest_year": ("2016-10-06T12:00:00Z", "2016-10-06T12:15:00Z"),
        "year_boundary": ("2025-12-31T23:55:00Z", "2026-01-01T00:10:00Z"),
        "dst_week": ("2026-03-09T12:00:00Z", "2026-03-09T12:15:00Z"),
    }
    evidence = {"environment": "Ubuntu standalone read-only SDK sample; no service instance",
                "sdk": "dukascopy-python==4.0.1", "cases": [],
                "full_ten_year_coverage": "not_tested", "calendar": "not_verified"}
    adapter = DukascopyHistory(proxy=config.market_proxy, page_size=500)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        for symbol in ("EURUSD", "XAUUSD"):
            identity = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
                account_scope="public", provider_symbol=symbol[:3] + "/" + symbol[3:], basis="bid",
                calendar_version="sample-only-unverified-v1")
            for name, bounds in cases.items():
                start, end = [int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
                              for value in bounds]
                before = time.monotonic()
                result = adapter.page(identity, start, end)
                rows = [row.model_dump() for row in result.rows]
                count = len(rows)
                precision = max((-Decimal(row[field]).normalize().as_tuple().exponent
                                  for row in rows for field in ("open", "high", "low", "close")), default=None)
                item = {"symbol": symbol, "case": name, "start": start, "end": end,
                        "observed_at": result.observed_at, "result": result.result.model_dump(mode="json"),
                        "rows": count, "expected_clock_minutes": (end - start) // 60000,
                        "elapsed_seconds": round(time.monotonic() - before, 3), "precision_observed": precision,
                        "checksum": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
                        "first": rows[0] if rows else None, "last": rows[-1] if rows else None}
                evidence["cases"].append(item)
                args.output.write_text(json.dumps(evidence, indent=2) + "\n")
                print(json.dumps({key: item[key] for key in ("symbol", "case", "result", "rows", "elapsed_seconds")}))
                # No retry loops after service rejection.
                if result.result.status in ("rate_limited", "unauthorized"):
                    return
                time.sleep(1)
    finally:
        adapter.close()
    print(json.dumps({"finished_at": datetime.now(UTC).isoformat(), "cases": len(evidence["cases"])}))


if __name__ == "__main__":
    main()
