"""Synthetic native-renderer probe; all indicator numbers are computed by Python."""
import json
from pathlib import Path

from alerts.chart_indicators import calculate, public_catalog
from alerts.supertrend_pine import NAME

fixture = json.loads(Path('backend/tests/fixtures/supertrend_pine_v1.json').read_text())
start, minute = 1791763200000, 60000
prices = fixture['ohlc'] * 20 + fixture['ohlc'][:4]
rows = [dict(zip(('open', 'high', 'low', 'close'), price),
             start=start + i * minute, end=start + (i + 1) * minute, complete=True)
        for i, price in enumerate(prices)]
rows[-1]['complete'] = False
spec = {'name': NAME, 'params': {'period': 2, 'multiplier': 1}}
phases = []
for close in (8, 11, 8):
    trial = [*rows[:-1], {**rows[-1], 'close': close}]
    phases.append({'bars': trial, 'indicator': calculate(trial, spec, provisional=True)})
gap_rows = [dict(open=10, high=11, low=9, close=10, start=start + i * minute,
                 end=start + (i + 1) * minute, complete=True,
                 **({'gap_before': True} if i == 70 else {})) for i in range(124)]
gap_spec = {'name': NAME, 'params': {'period': 1, 'multiplier': 1}}
print(json.dumps({'catalog': {NAME: public_catalog()[NAME]}, 'phases': phases,
                  'gap': {'bars': gap_rows, 'indicator': calculate(gap_rows, gap_spec)}}))
