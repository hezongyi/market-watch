"""Generate synthetic Python snapshots for the licensed native browser probe."""

import json
import math
from pathlib import Path

from alerts.chart_indicators import calculate, public_catalog

rows = []
for i in range(400):
    price = 100 + math.sin(i / 30)
    width = 0.15 if i % 40 >= 25 else 2
    rows.append(dict(start=1792828800000 - (400 - i) * 14400000,
                     end=1792828800000 - (399 - i) * 14400000,
                     open=price, close=price, high=price + width, low=price - width,
                     complete=True))
name = "ROLLING_RANGE_SQUEEZE"
params = dict(k=3, lookback=20, low_pct=50, confirm_on_close=False)
spec = dict(name=name, params=params)
result = calculate(rows, spec)
withdrawn = calculate([*rows[:-1], dict(rows[-1], high=120, low=80, complete=False)],
                      spec, provisional=True)
fixture = dict(bars=rows, catalog={name: public_catalog()[name]}, result=result,
               withdrawn=withdrawn, params=params)
output = Path(__file__).resolve().parents[1] / "artifacts/squeeze-native-data.js"
output.parent.mkdir(exist_ok=True)
output.write_text("const squeezeFixture=" + json.dumps(fixture) + ";\n")
print(output)
