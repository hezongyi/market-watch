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

from .calendar_profile import Closure, SourceSession, session_from

NY = ZoneInfo("America/New_York")
TIMEFRAMES = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600, "H4": 14400, "D1": 86400}


def aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("Timestamp must carry a timezone")
    return value.astimezone(UTC)


class Calendar(StrEnum):
    NY17 = "ny17"
    UTC0 = "utc0"
    SOURCE_DATE = "source_date"


@dataclass(frozen=True)
class SourceCalendar:
    phase: Calendar
    session: SourceSession | None = None


def calendar_phase(calendar):
    return calendar.phase if isinstance(calendar, SourceCalendar) else calendar


def calendar_from(phase, profile=None, *, explicit=False):
    phase = Calendar(phase)
    if phase == Calendar.SOURCE_DATE:
        if not profile or not profile.get("trading_date"):
            raise ValueError("Source trading-date calendar requires explicit exchange rules")
        return phase
    session = session_from(profile)
    return SourceCalendar(phase, session) if explicit or session is not None else phase


def calendar_for(instrument):
    return calendar_from(instrument.calendar, instrument.calendar_profile,
                         explicit=instrument.id.startswith("MD:"))


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
    volume: Decimal | None = None
    volume_complete: bool | None = None
    volume_supplied: bool = field(default=False, compare=False)

    def __post_init__(self):
        from .volume import quantity

        quantity(self.volume)
        object.__setattr__(self, "volume_supplied", self.volume_supplied or self.volume is not None)
        object.__setattr__(self, "volume_complete", bool(self.complete and self.volume is not None
            and (self.volume_complete if self.volume_complete is not None else True)))
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
    calendar = calendar_phase(calendar)
    if calendar == Calendar.SOURCE_DATE:
        raise ValueError("Source trading-date bars cannot be inferred from M1 sessions")
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
    if calendar_phase(calendar) == Calendar.SOURCE_DATE:
        raise ValueError("Source trading-date calendars do not certify minute coverage")
    if any(c.start <= moment < c.end for c in closures):
        return False
    if isinstance(calendar, SourceCalendar):
        session = calendar.session
        # Candidate phase is not proof that any missing minute was closed.
        # Reviewed rules certify only fully closed interiors; boundaries and
        # dates outside the finite review interval remain potentially open.
        if session and session.reviewed_start <= moment and moment + timedelta(minutes=1) <= session.reviewed_end:
            local = moment.astimezone(ZoneInfo(session.timezone))
            minute = local.weekday() * 1440 + local.hour * 60 + local.minute
            if any(c.start <= minute and minute + 1 <= c.end for c in session.weekly_closures):
                return False
        return True
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
    from .volume import total
    price_complete = all(b.complete for b in rows) and expected_starts <= actual
    volume = total(rows) if expected_starts <= actual else None
    return Candle(
        start,
        end,
        rows[0].open,
        max(b.high for b in rows),
        min(b.low for b in rows),
        rows[-1].close,
        price_complete,
        volume=volume,
        volume_complete=price_complete and all(b.volume_complete for b in rows),
        volume_supplied=True,
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
