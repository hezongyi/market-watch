"""Bounded per-bar native acceptance; never a page-wide observation advance."""
import hashlib
import json

from .provider_changes import native_projection

LIMIT = 2048
BATCH = 128


def fingerprint(bar, studies=False):
    try:
        value = list(native_projection(bar))
        if studies:
            # Python studies can depend on confirmation/coverage as well as
            # native OHLC and volume. Price-only receipts must not waive that.
            value.extend([bar.get("end"), bool(bar.get("complete")),
                          bar.get("source_confirmed", True),
                          bar.get("coverage_complete", True), bool(bar.get("gap_before"))])
        return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()
    except (TypeError, ValueError, KeyError, OverflowError):
        return None


def receipts(bars, studies=False, limit=LIMIT):
    result = []
    for bar in bars[-limit:]:
        token = fingerprint(bar, studies)
        if token:
            result.append({"start": bar["start"], "fingerprint": token})
    return result


def merge(previous, current):
    values = {row["start"]: row for row in [*previous, *current]}
    return [values[start] for start in sorted(values)[-LIMIT:]]
