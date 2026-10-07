"""Bounded, NULL-safe persistence with independent price and volume revisions."""
from dataclasses import dataclass, field

from sqlalchemy import case, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .storage import Audit, Bar, Instrument, candle_dict, ms, now_ms


@dataclass
class Changes:
    price: set[int] = field(default_factory=set)
    volume: set[int] = field(default_factory=set)
    conflicts: set[int] = field(default_factory=set)
    observation: set[int] = field(default_factory=set)


def write_bars(db, instrument_id, timeframe, candles, *, observed_at=None,
               volume_only=False, authoritative_volume=False, observation_only=False):
    # Caller holds the instrument lock; a page is bounded and last occurrence wins.
    db.scalar(select(Instrument).where(Instrument.id == instrument_id).with_for_update())
    unique = {ms(c.start): c for c in candles}
    changes = Changes()
    insert = pg_insert if db.get_bind().dialect.name == 'postgresql' else sqlite_insert
    keys = ('open', 'high', 'low', 'close', 'complete')
    entries = list(unique.items())
    for offset in range(0, len(entries), 500):
        batch = entries[offset:offset+500]
        old = {r.start: r for r in db.scalars(select(Bar).where(
            Bar.instrument_id == instrument_id, Bar.timeframe == timeframe,
            Bar.start.in_([start for start, _ in batch])))}
        stamp = now_ms()
        observation = stamp if observed_at is None else observed_at
        values = []
        for start, c in batch:
            row = old.get(start)
            price_changed = row is None or row.end != ms(c.end) or any(
                getattr(row, k) != getattr(c, k) for k in keys)
            if (volume_only or observation_only) and (row is None or price_changed):
                changes.conflicts.add(start)
                continue
            if row and (observation < row.observed_at or row.complete and not c.complete):
                continue
            if row is None or observation > row.observed_at:
                changes.observation.add(start)
            amount, final = c.volume, bool(c.volume_complete)
            if observation_only:
                amount, final = row.volume, row.volume_complete
            if row and not price_changed:
                if observation < row.volume_received_at:
                    amount, final = row.volume, row.volume_complete
                elif amount is None and not authoritative_volume:
                    amount, final = row.volume, row.volume_complete
            # A corrected price with unknown volume invalidates the old quantity.
            volume_changed = (row is None and amount is not None) or (row is not None and
                (row.volume != amount or row.volume_complete != final))
            if price_changed:
                changes.price.add(start)
            elif volume_changed:
                changes.volume.add(start)
            if row and price_changed:
                db.add(Audit(kind='candle_revision', details=dict(instrument=instrument_id,
                    timeframe=timeframe, previous=candle_dict(row.candle()))))
            if row and volume_changed:
                db.add(Audit(kind='volume_revision', details=dict(instrument=instrument_id,
                    timeframe=timeframe, start=start, previous=str(row.volume) if row.volume is not None else None,
                    volume=str(amount) if amount is not None else None)))
            values.append(dict(instrument_id=instrument_id, timeframe=timeframe, start=start,
                end=ms(c.end), **{k: getattr(c, k) for k in keys}, revision=1,
                received_at=stamp, observed_at=observation, volume=amount,
                volume_complete=final, volume_received_at=observation if c.volume_supplied else 0,
                volume_revision=int(amount is not None)))
        if values:
            stmt = insert(Bar.__table__)
            price_diff = or_(Bar.end.is_distinct_from(stmt.excluded.end),
                *(getattr(Bar, k).is_distinct_from(getattr(stmt.excluded, k)) for k in keys))
            volume_diff = or_(Bar.volume.is_distinct_from(stmt.excluded.volume),
                Bar.volume_complete.is_distinct_from(stmt.excluded.volume_complete))
            stmt = stmt.on_conflict_do_update(
                index_elements=[Bar.instrument_id, Bar.timeframe, Bar.start],
                set_={**{k: getattr(stmt.excluded, k) for k in (*keys, 'end', 'volume', 'volume_complete')},
                    'revision': case((price_diff, Bar.revision+1), else_=Bar.revision),
                    'received_at': case((price_diff, stamp), else_=Bar.received_at),
                    'observed_at': stmt.excluded.observed_at,
                    'volume_revision': case((volume_diff, Bar.volume_revision+1), else_=Bar.volume_revision),
                    'volume_received_at': case((stmt.excluded.volume_received_at > Bar.volume_received_at,
                        stmt.excluded.volume_received_at), else_=Bar.volume_received_at)},
                where=or_(price_diff, volume_diff, stmt.excluded.observed_at > Bar.observed_at,
                          stmt.excluded.volume_received_at > Bar.volume_received_at))
            db.execute(stmt, values)
        for row in old.values():
            db.expire(row)
    from .publication_jobs import enqueue_publication
    enqueue_publication(db, instrument_id, timeframe, changes.price | changes.volume | changes.observation)
    from .publication_schedule import request, source_frames
    if changes.price or changes.volume or changes.observation:
        request(db, instrument_id, frames=source_frames(timeframe))
    if timeframe == 'M1':
        # Metadata-only observations must reach matching stored aggregates too.
        # Price/volume updates already trigger their full aggregation in callers.
        observed_only = sorted(changes.observation - changes.price - changes.volume)
        from .chart_aggregation import enqueue_aggregation
        ranges = []
        for start in observed_only:
            if ranges and start == ranges[-1][1]:
                ranges[-1][1] += 60000
            else:
                ranges.append([start, start + 60000])
        for left, right in ranges:
            enqueue_aggregation(db, instrument_id, left, right,
                                stamp if observed_at is None else observed_at, kind='observed')
    db.flush()
    return changes
