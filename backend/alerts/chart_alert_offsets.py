"""ATR price offsets shared by ordinary and fixed-composite alert readers.

No acquisition, writes or notifications. Callers own the bound inputs and commit
the returned checkpoint with the observation, under the existing alert lock.
"""

import json
from dataclasses import replace
from decimal import Decimal

from .calendar_profile import closures_from
from .chart_history_plan import bucket_has_trading
from .composite_series import period
from .domain import calendar_from
from .indicator_state import ALGORITHM, IndicatorState
from .storage import instant


class OffsetPending(ValueError):
    pass


class OffsetComputing(OffsetPending):
    """Confirmed inputs are continuous; only the derived job is catching up."""


def reference_bar(start, frame, meta, instrument):
    """Find the expected closed bucket first, independently of available rows."""
    cursor = start
    calendar = calendar_from(meta["calendar"], meta.get("calendar_profile"),
        explicit=instrument.startswith("MD:") or meta.get("series_kind") == "composite")
    closures = closures_from(meta.get("calendar_profile"))
    for _ in range(10080):
        left, right = period(max(0, cursor - 1), frame, meta["calendar"])
        if right <= start and bucket_has_trading(instant(left), instant(right), calendar,
                                                 instrument == "XAUUSD", closures):
            return left, right
        if left <= 0:
            break
        cursor = left
    raise OffsetPending("ATR 开盘前尚无预期已收盘柱")


def resolve(spec, relation, bar, reference, value, *, dependency=None):
    """The adapter must supply exactly the expected reference and its value."""
    if not reference or reference["end"] > bar["start"]:
        raise OffsetPending("等待开盘前已收盘 ATR 参考柱")
    if not (reference.get("complete") and reference.get("source_confirmed", True)
            and reference.get("coverage_complete", True)):
        raise OffsetPending("最近预期 ATR 柱尚未完整或来源确认")
    if value is None:
        raise OffsetPending("ATR 完整初始化尚未完成")
    atr = Decimal(str(value))
    if not atr.is_finite() or atr < 0:
        raise OffsetPending("ATR 数值无效")
    signed = atr * spec.multiplier * (1 if relation in ("cross_up", "above") else -1)
    return {"kind": "atr", "version": "1", "atr": str(atr), "signed_offset": str(signed),
            "timeframe": spec.timeframe, "period": spec.period, "multiplier": str(spec.multiplier),
            "reference_start": reference["start"], "reference_end": reference["end"],
            "input_revision": reference.get("revision"),
            "confirmed_at": reference.get("observed_at", reference.get("end")),
            "evaluation_start": bar["start"], "algorithm": ALGORITHM,
            "dependency": dependency or {}}


def apply(base_target, resolved):
    if base_target is None:
        return None
    threshold = base_target + Decimal(resolved["signed_offset"])
    if not threshold.is_finite() or threshold <= 0:
        raise OffsetPending("ATR 偏移后的目标价格无效")
    resolved["base_target"] = str(base_target)
    resolved["threshold"] = str(threshold)
    return threshold


def rebase(state, previous, current):
    """Translate the prior target only; never consume a synthetic observation."""
    if state.right is None or not previous:
        return state, None
    change = Decimal(current["signed_offset"]) - Decimal(previous["signed_offset"])
    right = Decimal(state.right) + change
    return replace(state, right=str(right)), {"previous_right": state.right,
        "translated_right": str(right), "offset_change": str(change)}


def ordinary_values(rows, spec, checkpoint, fingerprint, *, cache=None):
    """Incremental Wilder state from one durable origin, with revision fencing.

    Only confirmed rows through the last required reference belong in rows.
    The caller verifies the committed prefix before using this checkpoint.
    """
    origin = checkpoint.get("origin", rows[0]["start"] if rows else None)
    if origin is None or not rows or not any(row["start"] == checkpoint.get("last_start", origin) for row in rows):
        raise OffsetPending("ATR 独立固定历史起点缺失")
    end = checkpoint.get("end", -1)
    engine = IndicatorState(spec.spec(), checkpoint.get("state"))
    key = (origin, spec.period, fingerprint(rows), json.dumps(checkpoint.get("state"), sort_keys=True))
    cached = cache.get(key) if cache is not None else None
    if cached:
        return cached
    values = dict(checkpoint.get("values", {}))
    for row in rows:
        if row["end"] > end:
            values[str(row["start"])] = engine.step(row)["value"]
    result = (values, {"origin": origin, "end": rows[-1]["end"], "last_start": rows[-1]["start"],
        "state": engine.checkpoint(), "fingerprint": fingerprint(rows),
        # The next turn only needs the last old reference plus newly added rows.
        "values": {str(rows[-1]["start"]): values.get(str(rows[-1]["start"]))}})
    if cache is not None:
        cache[key] = result
        while len(cache) > 32:
            cache.pop(next(iter(cache)))
    return result
