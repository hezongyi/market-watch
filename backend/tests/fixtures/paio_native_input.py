"""Reproducible native-rendering fixture, NOT an independent Pine oracle.

Run with PYTHONPATH=backend in the Ubuntu Docker API image. No database or I/O
other than writing the requested JSON file; prices and identity are synthetic.
"""
import argparse
import json
import math
from pathlib import Path

from alerts.chart_indicators import calculate, public_catalog, validate
from alerts.paio_inputs import attach

DAY = 86_400_000
ORIGIN = 1_780_272_000_000


def fixture():
    rows = []
    ranges = (6, 5, 4, 6.5, 5.5, 4.5, 4, 3.5, 5)
    for index in range(120):
        price, width = 100 + (index // 15 % 2) * 10, ranges[index % len(ranges)]
        start = ORIGIN + index * DAY
        rows.append(dict(start=start, end=start+DAY, chart_time=start, open=price,
            high=price+width, low=price-width, close=price+1, complete=True,
            indicator_calendar="utc0", indicator_timeframe="D1"))
    frames = {}
    for frame, duration in (("M15", 900_000), ("H1", 3_600_000)):
        bars = []
        for index in range(120 * DAY // duration):
            price = 100 + math.sin(index / 19)
            start = ORIGIN + index * duration
            bars.append(dict(start=start,end=start+duration,open=price,high=price+1,
                low=price-1,close=price+.1,complete=True))
        frames[frame] = dict(rows=bars,revision=1,epoch="synthetic-v1",origin=ORIGIN)
    frozen = dict(frames=frames,as_of=rows[-1]["end"],last_bar_time=rows[-1]["start"])
    results = {}
    for name, params in (("default", {}), ("plot", dict(pvLineDraw=False,ma_1_offset=2))):
        spec = dict(name="PAIO_V1",params=validate(dict(name="PAIO_V1",params=params))[1])
        results[name] = calculate(attach(rows,spec["params"],frozen,chart_frame="D1"),spec)
    return dict(catalog={"PAIO_V1":public_catalog()["PAIO_V1"]},bars=rows,results=results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output",type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(fixture(),ensure_ascii=False),encoding="utf8")
