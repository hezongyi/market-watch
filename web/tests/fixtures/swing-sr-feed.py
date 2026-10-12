"""Produce native probe input from frozen OANDA bars, using the real calculator."""

import json
from pathlib import Path

from alerts.chart_indicators import calculate, public_catalog

ROOT = Path(__file__).parents[3]
EVIDENCE = ROOT / "docs/research/patternsmart-evidence-20261012"


def records(name):
    return map(json.loads, (EVIDENCE / name).read_text().splitlines())


native = [row["payload"] for row in records("long_snapshot.jsonl") if row["kind"] == "provider_bar"]
tail = [row for row in records("snapshot.jsonl") if row["kind"] == "managed_bar"]
rows = native + [row for row in tail if row["start"] > native[-1]["start"]]
spec = {"name": "SWING_SR_V1"}
fixture = {
    "catalog": public_catalog(),
    "bars": rows,
    "result": calculate(rows, spec, provisional=True),
    "withdrawn": calculate([*rows[:-1], {**rows[-1], "high": 1.125}], spec, provisional=True),
    "confirmed": calculate([*rows[:-1], {**rows[-1], "complete": True}], spec),
    "variants": {},
    "legacy": {name: calculate(rows, {"name": name}, provisional=True)
               for name in public_catalog() if name != "SWING_SR_V1"},
}
for high, low in [(3, 7), (1, 2)]:
    params = {"high_strength": high, "low_strength": low}
    fixture["variants"][json.dumps(params, separators=(",", ":"))] = calculate(
        rows, spec | {"params": params}, provisional=True
    )
output = ROOT / "artifacts/swing-native-data.js"
output.parent.mkdir(exist_ok=True)
output.write_text("globalThis.swingFixture=" + json.dumps(fixture, allow_nan=False) + ";")
print(f"Native probe fixture: {len(rows)} OANDA candles → {output}")
