"""Compare current provider RRS against an independent oracle on a frozen capture.

Run with PYTHONPATH=backend:backend/tests. The capture stays in private storage;
only aggregate results and its checksum are printed. No database or network I/O.
"""

import argparse
import hashlib
import json
from pathlib import Path

from alerts.provider_indicator_inputs import Inputs, compute
from test_rolling_range_squeeze import literal_pine, matrix


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    raw = args.snapshot.read_bytes()
    frozen = json.loads(raw)
    rows = frozen["rows"]
    assert len(rows) > 261
    assert all(row["complete"] and not row.get("gap_before") for row in rows)
    oracle_rows = [
        {**row, **{key: float(row[key]) for key in ("open", "high", "low", "close")}}
        for row in rows
    ]
    expected, segments = literal_pine(oracle_rows, 10, 252, 5)
    inputs = Inputs(rows, ("frozen-rrs-regression",), "fixed", 1)
    spec = {"name": "ROLLING_RANGE_SQUEEZE"}
    kwargs = dict(provisional=False, timeframe="D1")
    actual = compute(inputs, frozen["meta"], frozen["instrument"], spec,
                     first=rows[0]["start"], **kwargs)
    errors = []
    for value, reference in zip(matrix(actual), expected, strict=True):
        for own, target in zip(value, reference, strict=True):
            assert (own is None) == (target is None)
            if own is not None:
                errors.append(abs(own - target))
                assert abs(own - target) < 1e-12
    boxes = actual["presentation"]["boxes"]
    labels = actual["presentation"]["labels"]
    assert len(labels) == len(segments) > 0
    assert len(boxes) == sum(1 + (segment["first"] != segment["right"]) for segment in segments)
    for segment, label in zip(segments, labels, strict=True):
        assert label["time"] == rows[segment["first"]]["start"]
        assert (label["price"], label["pct_rank"]) == (segment["top"], segment["rank"])
        for box in (item for item in boxes if item["first"] == label["time"]):
            assert box["left"] == rows[segment["left"]]["start"]
            assert (box["top"], box["bottom"]) == (segment["top"], segment["bottom"])
            right = segment["first"] if box["kind"] == "first" else segment["right"]
            assert box["right"] == rows[right]["start"]
    paged = compute(inputs, frozen["meta"], frozen["instrument"], spec,
                    first=rows[-100]["start"], **kwargs)
    assert matrix(paged) == matrix(actual)[-100:]
    assert paged["presentation"] == actual["presentation"]
    print(json.dumps({
        "passed": True, "rows": len(rows), "snapshot_sha256": hashlib.sha256(raw).hexdigest(),
        "timeframe": "D1", "null_pattern_equal": True, "max_abs_error": max(errors),
        "threshold_non_null": sum(row[2] is not None for row in expected),
        "boxes": len(boxes), "labels": len(labels), "geometry_equal": True,
        "paged_values_and_full_drawings_equal": True, "independent_literal_oracle": True,
        "network_or_database_access": False,
    }, indent=2))


if __name__ == "__main__":
    main()
