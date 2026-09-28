"""Pure market rules. No I/O, global clock, network or notifications.

Prices use Decimal. A caller controls the event clock and supplies only closed bars.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from functools import lru_cache
from typing import Literal
from zoneinfo import ZoneInfo

from .calendar_profile import Closure
from .indicators import get_indicator

NY = ZoneInfo("America/New_York")
TIMEFRAMES = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600, "H4": 14400, "D1": 86400}


def aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("Timestamp must carry a timezone")
    return value.astimezone(UTC)


class Calendar(StrEnum):
    NY17 = "ny17"
    UTC0 = "utc0"


@dataclass(frozen=True)
class Candle:
    start: datetime
    end: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    complete: bool = True
    revision: int = 1

    def __post_init__(self):
        aware(self.start)
        aware(self.end)
        if self.end <= self.start:
            raise ValueError("Invalid candle interval")
        if not all(p.is_finite() and p > 0 for p in (self.open, self.high, self.low, self.close)):
            raise ValueError("Prices must be positive finite Decimal values")
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close):
            raise ValueError("Invalid OHLC extremes")


def session_bounds(moment: datetime, calendar: Calendar) -> tuple[datetime, datetime]:
    moment = aware(moment)
    zone = NY if calendar == Calendar.NY17 else UTC
    local = moment.astimezone(zone)
    start = local.replace(
        hour=17 if calendar == Calendar.NY17 else 0, minute=0, second=0, microsecond=0
    )
    if local < start:
        start -= timedelta(days=1)
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


def bucket_bounds(moment: datetime, timeframe: str, calendar: Calendar):
    seconds = TIMEFRAMES[timeframe]
    start, end = session_bounds(moment, calendar)
    if timeframe == "D1":
        return start, end
    index = int((aware(moment) - start).total_seconds()) // seconds
    left = start + timedelta(seconds=index * seconds)
    return left, min(left + timedelta(seconds=seconds), end)


def scheduled_open(
    moment: datetime, calendar: Calendar, *, gold: bool = False, closures: tuple[Closure, ...] = ()
) -> bool:
    """Weekly schedule plus explicitly confirmed half-open closure intervals."""
    moment = aware(moment)
    if any(c.start <= moment < c.end for c in closures):
        return False
    if calendar == Calendar.UTC0:
        return True
    local = aware(moment).astimezone(NY)
    day, hour = local.weekday(), local.hour
    if day == 5 or (day == 4 and hour >= 17) or (day == 6 and hour < 17):
        return False
    # Spot metals commonly have a daily maintenance break. Adapter profile must validate it.
    return not (gold and hour == 17)


def previous_session(
    moment: datetime, calendar: Calendar, *, gold: bool = False, closures: tuple[Closure, ...] = ()
):
    """Previous scheduled session, not merely the last stored daily candle."""
    start, _ = session_bounds(moment, calendar)
    return _previous_session(start, calendar, gold, closures)


@lru_cache(maxsize=4096)
def _previous_session(start, calendar, gold, closures):
    for _ in range(366):
        left, right = session_bounds(start - timedelta(microseconds=1), calendar)
        probe = left
        while probe < right:
            if scheduled_open(probe, calendar, gold=gold, closures=closures):
                return left, right
            probe += timedelta(minutes=1)
        start = left
    raise ValueError("No scheduled session found")


def has_trading_gap(
    previous_end: datetime,
    current_start: datetime,
    calendar: Calendar,
    *,
    gold: bool = False,
    closures: tuple[Closure, ...] = (),
) -> bool:
    cursor = previous_end
    while cursor < current_start:
        if scheduled_open(cursor, calendar, gold=gold, closures=closures):
            return True
        cursor += timedelta(minutes=1)
    return False


def shortened_h4(bar: Candle, timeframe: str, closures: tuple[Closure, ...] = ()) -> bool:
    """A holiday-truncated H4 cannot stand in for an ordinary four-hour event."""
    return timeframe == "H4" and (
        bar.end - bar.start != timedelta(hours=4)
        or any(
            c.kind == "holiday" and c.start < bar.end and c.end > bar.start for c in closures
        )
    )


def aggregate(
    minutes: list[Candle], start: datetime, end: datetime, *, expected_starts: set[datetime]
) -> Candle | None:
    """Never manufacture missing prices. Incomplete bars may be drawn but not traded."""
    rows = sorted((b for b in minutes if start <= b.start < end), key=lambda b: b.start)
    if not rows:
        return None
    if len({b.start for b in rows}) != len(rows):
        raise ValueError("Duplicate minute revisions must be resolved before aggregation")
    if any(b.end - b.start != timedelta(minutes=1) for b in rows):
        raise ValueError("Aggregation input must be M1")
    actual = {b.start for b in rows}
    return Candle(
        start,
        end,
        rows[0].open,
        max(b.high for b in rows),
        min(b.low for b in rows),
        rows[-1].close,
        all(b.complete for b in rows) and expected_starts <= actual,
    )


@dataclass(frozen=True)
class Rule:
    kind: Literal["pullback", "previous_day", "price", "indicator"]
    timeframe: str = "H4"
    direction: Literal["buy", "sell", "both"] = "both"
    consecutive: int = 2
    level: Decimal | None = None
    touch: bool = False
    version: str = "1"
    indicator: str = "sma_cross"
    indicator_version: str = "1"
    indicator_params: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.version != "1":
            raise ValueError("Unsupported strategy version")
        if self.kind not in {"pullback", "previous_day", "price", "indicator"}:
            raise ValueError("Unknown strategy")
        if self.timeframe not in TIMEFRAMES and not (
            self.kind == "price" and self.timeframe == "tick"
        ):
            raise ValueError("Unknown timeframe")
        if self.direction not in {"buy", "sell", "both"}:
            raise ValueError("Unknown direction")
        if not 2 <= self.consecutive <= 100:
            raise ValueError("Consecutive count must be 2–100")
        if self.kind == "price" and (
            self.level is None or not self.level.is_finite() or self.level <= 0
        ):
            raise ValueError("Price alert requires a positive finite level")
        if self.kind == "indicator":
            plugin = get_indicator(self.indicator, self.indicator_version)
            object.__setattr__(self, "indicator_params", plugin.validate(self.indicator_params))


@dataclass
class State:
    previous: Candle | None = None
    down_count: int = 0
    up_count: int = 0
    buy_ready: bool = False
    sell_ready: bool = False
    last_event: datetime | None = None
    indicator_closes: list[str] = field(default_factory=list)
    indicator_reading: dict | None = None


@dataclass(frozen=True)
class Signal:
    direction: str
    occurred_at: datetime
    price: Decimal
    threshold: Decimal
    reason: str
    evidence: dict = field(default_factory=dict)


def crossed(previous: Decimal, current: Decimal, level: Decimal, up: bool, touch=False):
    if up:
        return previous < level <= current if touch else previous <= level < current
    return previous > level >= current if touch else previous >= level > current


def advance(
    rule: Rule,
    state: State,
    bar: Candle,
    *,
    previous_day: Candle | None = None,
    armed_at: datetime | None = None,
) -> Signal | None:
    """Warmup calls use armed_at=None and consume historical signals without emitting.

    Caller persists state and calls on all events in chronological order. An incomplete
    bar raises instead of silently skipping a gap. Previous daily context must be closed.
    """
    if not bar.complete:
        raise ValueError("Cannot evaluate an incomplete candle")
    if state.last_event and bar.end <= state.last_event:
        raise ValueError("Events must be strictly chronological")
    prior = state.previous
    signal = None
    indicator_previous = state.indicator_reading
    indicator_current = None
    if rule.kind == "indicator":
        plugin = get_indicator(rule.indicator, rule.indicator_version)
        lookback = plugin.lookback(rule.indicator_params)
        state.indicator_closes = [*state.indicator_closes, str(bar.close)][-lookback:]
        if len(state.indicator_closes) == lookback:
            reading = plugin.calculate(state.indicator_closes, rule.indicator_params)
            value, reference = Decimal(str(reading.value)), Decimal(str(reading.reference))
            if not value.is_finite() or not reference.is_finite():
                raise ValueError("Indicator returned a non-finite reading")
            indicator_current = {"value": str(value), "reference": str(reference)}
        state.indicator_reading = indicator_current
    if rule.kind == "previous_day" and previous_day is not None:
        if not previous_day.complete or previous_day.end > bar.start:
            raise ValueError("Previous session must be completed before the current bar")
    if prior:
        for up in (True, False):
            direction = "buy" if up else "sell"
            if rule.direction not in ("both", direction):
                continue
            threshold = None
            if rule.kind == "pullback":
                ready = state.buy_ready if up else state.sell_ready
                candidate = prior.high if up else prior.low
                if ready and (bar.close > candidate if up else bar.close < candidate):
                    threshold = candidate
            elif rule.kind == "previous_day" and previous_day:
                candidate = previous_day.high if up else previous_day.low
                if crossed(prior.close, bar.close, candidate, up):
                    threshold = candidate
            elif rule.kind == "price":
                if crossed(prior.close, bar.close, rule.level, up, rule.touch):
                    threshold = rule.level
            elif rule.kind == "indicator" and indicator_previous and indicator_current:
                before = Decimal(indicator_previous["value"]) - Decimal(
                    indicator_previous["reference"]
                )
                after = Decimal(indicator_current["value"]) - Decimal(
                    indicator_current["reference"]
                )
                if crossed(before, after, Decimal(0), up):
                    threshold = Decimal(indicator_current["reference"])
            if threshold is not None:
                signal = Signal(
                    direction,
                    bar.end,
                    bar.close,
                    threshold,
                    {
                        "pullback": "回落后收破前高" if up else "反弹后收破前低",
                        "previous_day": "收盘上破前日高点" if up else "收盘下破前日低点",
                        "price": "价格向上穿越" if up else "价格向下穿越",
                        "indicator": "指标上穿参考线" if up else "指标下穿参考线",
                    }[rule.kind],
                    {
                        "previous_close": str(prior.close),
                        "rule_version": rule.version,
                        **(
                            {
                                "indicator": rule.indicator,
                                "indicator_version": rule.indicator_version,
                                "indicator_params": dict(rule.indicator_params),
                                "indicator_previous": indicator_previous,
                                "indicator_current": indicator_current,
                                "indicator_engine": "TA-Lib 0.6.8",
                            }
                            if rule.kind == "indicator"
                            else {}
                        ),
                        "bar_start": bar.start.isoformat(),
                        "revision": bar.revision,
                        "trigger_bar": {
                            "start": bar.start.isoformat(),
                            "end": bar.end.isoformat(),
                            "open": str(bar.open),
                            "high": str(bar.high),
                            "low": str(bar.low),
                            "close": str(bar.close),
                            "revision": bar.revision,
                        },
                        "previous_bar": {
                            "start": prior.start.isoformat(),
                            "end": prior.end.isoformat(),
                            "open": str(prior.open),
                            "high": str(prior.high),
                            "low": str(prior.low),
                            "close": str(prior.close),
                            "revision": prior.revision,
                        },
                        "previous_day": {
                            "start": previous_day.start.isoformat(),
                            "end": previous_day.end.isoformat(),
                            "high": str(previous_day.high),
                            "low": str(previous_day.low),
                            "revision": previous_day.revision,
                        }
                        if previous_day is not None
                        else None,
                    },
                )
                if up:
                    state.buy_ready = False
                else:
                    state.sell_ready = False
                break
    # Track both mirrored formations, including during warmup after a consumed signal.
    state.down_count = (
        (state.down_count + 1 if prior and state.down_count and bar.low < prior.low else 1)
        if bar.close < bar.open
        else 0
    )
    state.up_count = (
        (state.up_count + 1 if prior and state.up_count and bar.high > prior.high else 1)
        if bar.close > bar.open
        else 0
    )
    state.buy_ready |= state.down_count >= rule.consecutive
    state.sell_ready |= state.up_count >= rule.consecutive
    state.previous = bar
    state.last_event = bar.end
    if signal and armed_at is not None and signal.occurred_at > aware(armed_at):
        return signal
    return None
