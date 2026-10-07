"""Independent M15/D1 -> M30/W1/MN arithmetic for the fixed P0 fixture.

No product calendar, aggregation, published-read or serialization functions.
Inputs are explicit source records; this does not validate how M15/D1 were built.
"""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

MINUTE = 60000
NY = ZoneInfo('America/New_York')


def instant(stamp):
    return datetime.fromtimestamp(stamp/1000, UTC)


def stamp(moment):
    return int(moment.timestamp()*1000)


def boundary(value, frame, calendar):
    local = instant(value).astimezone(NY if calendar == 'ny17' else UTC)
    if frame == 'M30':
        session = local.replace(hour=17 if calendar == 'ny17' else 0, minute=0, second=0, microsecond=0)
        if local < session:
            session -= timedelta(days=1)
        session_utc = session.astimezone(UTC)
        left = session_utc + timedelta(minutes=30*int((instant(value)-session_utc).total_seconds()//1800))
        return stamp(left), stamp(min(left+timedelta(minutes=30), (session+timedelta(days=1)).astimezone(UTC)))
    trading_day = (local+timedelta(hours=7)).date() if calendar == 'ny17' else local.date()
    if frame == 'W1':
        first = trading_day-timedelta(days=trading_day.weekday())
        last = first+timedelta(days=7)
    elif frame == 'MN':
        first = trading_day.replace(day=1)
        last = (first.replace(day=28)+timedelta(days=4)).replace(day=1)
    else:
        raise ValueError(frame)

    def at(day):
        if calendar == 'ny17':
            day -= timedelta(days=1)
        return stamp(datetime(day.year, day.month, day.day,
            17 if calendar == 'ny17' else 0, tzinfo=NY if calendar == 'ny17' else UTC))
    return at(first), at(last)


def opened(value, meta):
    moment = instant(value)
    for closure in meta['calendar_profile'].get('closures', []):
        if datetime.fromisoformat(closure['start']) <= moment < datetime.fromisoformat(closure['end']):
            return False
    if meta['calendar'] == 'utc0':
        return True
    local = moment.astimezone(NY)
    if local.weekday() == 5 or local.weekday() == 4 and local.hour >= 17 or local.weekday() == 6 and local.hour < 17:
        return False
    return not (meta['instrument'] == 'XAUUSD' and local.hour == 17)


def expected(source, frame, meta, coverage_start, coverage_end, now):
    groups = {}
    for row in source:
        left, right = boundary(row['start'], frame, meta['calendar'])
        if left >= coverage_start and left < coverage_end:
            groups.setdefault((left, right), []).append(row)
    result = []
    for (left, right), members in sorted(groups.items()):
        members.sort(key=lambda row: row['start'])
        # Closed, explicitly covered empty sessions are legitimate. For an
        # unclosed bucket every scheduled source slot is required for complete.
        slots = []
        if frame == 'M30':
            slots = [left, left+15*MINUTE]
            required = {slot for slot in slots if any(opened(t, meta)
                for t in range(slot, min(slot+15*MINUTE, right), MINUTE))}
        else:
            zone = NY if meta['calendar'] == 'ny17' else UTC
            local = instant(left).astimezone(zone)
            while stamp(local) < right:
                a, z = stamp(local), stamp(local+timedelta(days=1))
                if any(opened(t, meta) for t in range(a, z, MINUTE)):
                    slots.append(a)
                local += timedelta(days=1)
            required = set(slots)
        complete = bool(required) and required <= {row['start'] for row in members} and all(row['complete'] for row in members)
        if frame != 'M30' and right <= coverage_end:
            complete = all(row['complete'] for row in members)
        if frame != 'M30' and meta['instrument'] == 'XAUUSD' and right > coverage_end:
            maintenance = meta['calendar_profile'].get('closures', [])
            complete = complete and all(any(c.get('kind') == 'maintenance' and
                stamp(datetime.fromisoformat(c['start'])) <= day < stamp(datetime.fromisoformat(c['end']))
                for c in maintenance) for day in required)
        final = complete and right <= now
        if right <= coverage_end and not final:
            # Closed incomplete candidates do not become confirmed snapshots.
            continue
        amount = sum((Decimal(row['volume']) for row in members), Decimal(0)) if complete and all(row['volume'] is not None for row in members) else None
        result.append(dict(start=left, end=right, open=members[0]['open'],
            high=str(max(Decimal(row['high']) for row in members)),
            low=str(min(Decimal(row['low']) for row in members)), close=members[-1]['close'],
            complete=final, revision=max(row['revision'] for row in members),
            volume=format(amount, 'f') if amount is not None else None,
            volume_complete=final and all(row['volume_complete'] for row in members),
            observed_at=max(row['observed_at'] or row['received_at'] for row in members)))
    return result
