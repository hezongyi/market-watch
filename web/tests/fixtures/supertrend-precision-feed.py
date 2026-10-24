"""Deterministic forex prices; every Supertrend value uses the production calculator."""
import json
import math

from alerts.chart_indicators import calculate, public_catalog

rows = []
for i in range(400):
    center = 1.12 + 0.01 * math.sin(i / 7)
    rows.append(dict(start=1760000400000 + i * 14400000, open=center - 0.00021,
                     high=center + 0.00131, low=center - 0.00127,
                     close=center + 0.00012, complete=True))
name = "SUPERTREND_PINE_V1"
print(json.dumps(dict(catalog={name: public_catalog()[name]}, bars=rows,
                      result=calculate(rows, {"name": name})), allow_nan=False))
