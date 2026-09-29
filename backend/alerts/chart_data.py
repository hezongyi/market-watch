"""Chart-only periods. Calendar aggregation never changes strategy TIMEFRAMES."""

from datetime import UTC, datetime, timedelta
from functools import lru_cache

from sqlalchemy import select

from .calendar_profile import closures_from
from .domain import NY, Calendar, Candle, scheduled_open, session_bounds
from .storage import Bar, candle_dict, instant, ms

FRAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN")


def bounds(moment, frame, calendar):
    zone = NY if calendar == Calendar.NY17 else UTC
    local = moment.astimezone(zone)
    if frame == "M30":
        start, end = session_bounds(moment, calendar)
        left = start + timedelta(minutes=30 * int((moment - start).total_seconds() // 1800))
        return left, min(left + timedelta(minutes=30), end)
    # NY17 daily bars are attributed to their END date; UTC0 to their START date.
    day = (local + timedelta(hours=7)).date() if calendar == Calendar.NY17 else local.date()
    if frame == "W1":
        first = day - timedelta(days=day.weekday())
        last = first + timedelta(days=7)
    elif frame == "MN":
        first = day.replace(day=1)
        last = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    else:
        raise ValueError("Unsupported aggregate period")

    def boundary(d):
        value = datetime(d.year, d.month, d.day, tzinfo=zone)
        if calendar == Calendar.NY17:
            value = value - timedelta(days=1) + timedelta(hours=17)
        return value.astimezone(UTC)

    return boundary(first), boundary(last)


@lru_cache(maxsize=8192)
def expected_days(left, right, calendar, gold, closures):
    expected = set()
    cursor = left
    while cursor < right:
        day_start, day_end = session_bounds(cursor, calendar)
        probe = day_start
        while probe < day_end:
            if scheduled_open(probe, calendar, gold=gold, closures=closures):
                expected.add(ms(day_start))
                break
            probe += timedelta(minutes=1)
        cursor = day_end
    return frozenset(expected)


def chart_rows(db, instrument, frame, before, limit, now):
    if frame not in FRAMES:
        raise ValueError("未知图表周期")
    if frame not in ("M30", "W1", "MN"):
        rows = db.scalars(
            select(Bar)
            .where(Bar.instrument_id == instrument.id, Bar.timeframe == frame, Bar.start < before)
            .order_by(Bar.start.desc())
            .limit(limit)
        ).all()[::-1]
        return [candle_dict(r.candle()) for r in rows]
    calendar = Calendar(instrument.calendar)
    source = "M15" if frame == "M30" else "D1"
    # Paginate whole target buckets, so a request never cuts a source bucket in half.
    cutoff_end = bounds(instant(before - 1), frame, calendar)[1]
    source_limit = limit * (2 if source == "M15" else 32 if frame == "MN" else 7) + 32
    rows = db.scalars(
        select(Bar)
        .where(
            Bar.instrument_id == instrument.id, Bar.timeframe == source, Bar.start < ms(cutoff_end)
        )
        .order_by(Bar.start.desc())
        .limit(source_limit)
    ).all()[::-1]
    groups = {}
    for row in rows:
        left, right = bounds(instant(row.start), frame, calendar)
        if ms(left) < before:
            groups.setdefault((left, right), []).append(row)
    closures = closures_from(instrument.calendar_profile)
    result = []
    for (left, right), members in sorted(groups.items())[-limit:]:
        if frame == "M30":
            expected = set()
            cursor = left
            while cursor < right:
                stop = cursor + timedelta(minutes=15)
                probe = cursor
                while probe < stop:
                    if scheduled_open(
                        probe, calendar, gold=instrument.id == "XAUUSD", closures=closures
                    ):
                        expected.add(ms(cursor))
                        break
                    probe += timedelta(minutes=1)
                cursor = stop
            complete = bool(expected) and expected <= {r.start for r in members}
            complete = complete and all(r.complete for r in members)
            c = Candle(
                left,
                right,
                members[0].open,
                max(r.high for r in members),
                min(r.low for r in members),
                members[-1].close,
                complete,
            )
        else:
            expected = expected_days(left, right, calendar, instrument.id == "XAUUSD", closures)
            complete = bool(expected) and expected <= {r.start for r in members}
            complete = complete and all(r.complete for r in members)
            if instrument.id == "XAUUSD":
                # Gold's daily maintenance is date-generated, not an eternal rule.
                # Every expected D1 needs explicit coverage of its NY17 maintenance start.
                maintenance = [c for c in closures if c.kind == "maintenance"]
                complete = complete and all(
                    any(ms(c.start) <= day < ms(c.end) for c in maintenance) for day in expected
                )
            c = Candle(
                left,
                right,
                members[0].open,
                max(r.high for r in members),
                min(r.low for r in members),
                members[-1].close,
                complete,
            )
        c = Candle(
            c.start,
            c.end,
            c.open,
            c.high,
            c.low,
            c.close,
            complete and ms(right) <= now,
            max(r.revision for r in members),
        )
        result.append(candle_dict(c))
    return result


def future_grid(instrument, frame, after, count=120):
    """Known calendar coordinates, not synthetic prices or future trading guarantees."""
    return _future_grid(
        Calendar(instrument.calendar),
        closures_from(instrument.calendar_profile),
        instrument.id == "XAUUSD",
        frame,
        after,
        count,
    )


@lru_cache(maxsize=256)
def _future_grid(calendar, closures, gold, frame, after, count):
    from .domain import bucket_bounds

    cursor = instant(after)
    result = []
    for _ in range(count * 12):
        if frame in ("M30", "W1", "MN"):
            left, right = bounds(cursor, frame, calendar)
        else:
            left, right = bucket_bounds(cursor, frame, calendar)
        probe = left
        exists = False
        while probe < right:
            if scheduled_open(probe, calendar, gold=gold, closures=closures):
                exists = True
                break
            probe += timedelta(minutes=1)
        if exists:
            result.append({"start": ms(left), "end": ms(right)})
        if len(result) >= count:
            break
        cursor = right
    return result
