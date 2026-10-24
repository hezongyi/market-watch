"""Deterministic synthetic candles evaluated by the production Swing calculator."""
import json
import math
from pathlib import Path

from alerts.chart_indicators import calculate, public_catalog

root = Path(__file__).parents[3]
rows = []
for i in range(800):
    center = 2700 + 12 * math.sin(i / 7) + 2 * math.sin(i / 3)
    rows.append({"start": 1760000400000 + i * 14400000,
                 "open": center - 0.21345, "close": center + 0.12345,
                 "high": center + 1.31415, "low": center - 1.27182, "complete": True})
spec = {"name": "SWING_SR_V1"}
fixture = {"catalog": public_catalog(), "bars": rows, "result": calculate(rows, spec),
           "variants": {}, "legacy": {}}
for high, low in [(3, 7), (1, 2)]:
    params = {"high_strength": high, "low_strength": low}
    fixture["variants"][json.dumps(params, separators=(",", ":"))] = calculate(rows, spec | {"params": params})
output = root / "artifacts/swing-notice-data.js"
output.parent.mkdir(exist_ok=True)
output.write_text("globalThis.swingFixture=" + json.dumps(fixture, allow_nan=False) + ";")
