"""Read-only live adapter evidence. Run with PYTHONPATH=backend; no database.

Usage: python docs/verification/akshare-native-periods-20261112/probe_native.py OUTPUT.json
This validates the adapter itself; isolated application/UI acceptance is separate.
"""

import hashlib
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from alerts.akshare_native import COUNTS, fetch, native_metadata, route, source_identity
from alerts.market_contracts import NativeCandleBatch
from alerts.provider_akshare import parse_records

report = {"started_at": datetime.now(UTC).isoformat(), "scope": "live direct adapter; no application database or aggregation",
          "cases": [], "passed": False}
output = Path(sys.argv[1])
for family, symbols in (("sina-a", ("SSE:600519", "SZSE:000001")),
                        ("tencent-a", ("SSE:600519", "SZSE:000001")),
                        ("tencent-hk", ("HKEX:00700", "HKEX:02318"))):
    for symbol in symbols:
        meta = {**native_metadata(family), "symbol": symbol}
        for frame in meta["frames"]:
            started = time.monotonic()
            entry = {"family": family, "symbol": symbol, "frame": frame, "adjustment": "none"}
            report["cases"].append(entry)
            try:
                url, parameters = route(meta["native_operation"], symbol, frame, COUNTS[family])
                records = fetch(meta["native_operation"], symbol, frame, COUNTS[family])
                observed = int(time.time() * 1000)
                source = source_identity(meta, frame)
                end = (observed // 86400000 + 1) * 86400000
                warnings = []
                rows = parse_records(source, records, start=0, end=end, observed_at=observed,
                                     invalid_records=warnings)
                batch = NativeCandleBatch(identity=source, timeframe=frame, window_start=0,
                    window_end=end, checkpoint=end, observed_at=observed, rows=rows,
                    result={"status": "data"}, volume_kind="quantity", volume_unit=meta["volume_unit"],
                    source_warnings=warnings)
                assert len(batch.rows) >= 2
                entry.update(passed=True, url=url, parameters=parameters, rows=len(rows),
                    source_id=source.key, volume_unit=meta["volume_unit"], source_warnings=warnings,
                    first=rows[0].model_dump(), last=rows[-1].model_dump(),
                    raw_sha256=hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest())
            except Exception as error:
                entry.update(passed=False, error_type=type(error).__name__)
            entry["seconds"] = round(time.monotonic() - started, 3)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(f'{family} {symbol} {frame}: {entry.get("rows", entry.get("error_type"))}', flush=True)
report["passed"] = len(report["cases"]) == 38 and all(case["passed"] for case in report["cases"])
report["finished_at"] = datetime.now(UTC).isoformat()
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
raise SystemExit(0 if report["passed"] else 1)
