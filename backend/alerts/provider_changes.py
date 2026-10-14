"""Bounded, value-free source-change observations; never consumer evidence."""
import math
from collections import Counter


def native_projection(bar):
    """Match the main native Bar projection (including actual supplied volume)."""
    prices = tuple(float(bar[key]) for key in ("open", "high", "low", "close"))
    if not all(math.isfinite(value) for value in prices):
        raise ValueError("Non-finite native OHLC")
    raw = bar.get("volume")
    volume = float(raw) if raw is not None else None
    if volume is not None and (not math.isfinite(volume) or volume < 0):
        volume = None
    chart_time = bar.get("chart_time")
    return (bar["start"] if chart_time is None else chart_time, *prices, volume)


def classification(old, new):
    if old is None:
        return "inserted"
    if old == new:
        return "unchanged"
    try:
        before, after = native_projection(old), native_projection(new)
    except (TypeError, ValueError, KeyError, OverflowError):
        return "unknown"
    if before[0] != after[0]:
        return "label"
    price, volume = before[1:5] != after[1:5], before[5] != after[5]
    return "mixed" if price and volume else "ohlc" if price else "volume" if volume else "metadata"


class ChangeSummary:
    def __init__(self):
        self.counts = Counter()
        self.volume_relative = Counter()
        self.confirmation_delay = Counter()

    def accept(self, old, new, observed_at):
        kind = classification(old, new)
        self.counts[kind] += 1
        if kind in ("volume", "mixed"):
            previous, current = native_projection(old)[-1], native_projection(new)[-1]
            if previous is None or current is None:
                bucket = "availability"
            elif previous == 0:
                bucket = "from_zero"
            else:
                relative = abs(current - previous) / abs(previous)
                bucket = "lt_0.01" if relative < .01 else "0.01_to_0.1" if relative < .1 else "0.1_to_1" if relative <= 1 else "gt_1"
            self.volume_relative[bucket] += 1
        if old and not old.get("complete") and new.get("complete"):
            delay = max(0, observed_at - new["end"])
            bucket = "le_1s" if delay <= 1000 else "le_10s" if delay <= 10000 else "le_60s" if delay <= 60000 else "gt_60s"
            self.confirmation_delay[bucket] += 1

    def report(self, source, frame, revision, dataset_ref):
        return {"source": source, "timeframe": frame, "revision": revision,
                "dataset_ref": dataset_ref,
                "counts": dict(self.counts),
                "volume_relative_buckets": dict(self.volume_relative),
                "confirmation_delay_buckets": dict(self.confirmation_delay)}
