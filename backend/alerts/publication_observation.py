"""Advance proven snapshot freshness without creating a content revision.

The caller holds Instrument, just like the ordinary publication writer. A
snapshot with different content/confirmation stays on the correction path.
"""

from sqlalchemy import select

from .storage import Bar, ChartPublishedBar, candle_dict


def content(payload):
    return {k: v for k, v in payload.items() if k != 'observed_at'}


def refresh(db, instrument_id, frame, starts):
    """Return starts that still require ordinary publication reconciliation."""
    remaining = set(starts)
    for offset in range(0, len(starts), 500):
        page = sorted(starts)[offset:offset+500]
        snapshots = {row.start: row for row in db.scalars(select(ChartPublishedBar).where(
            ChartPublishedBar.instrument_id == instrument_id,
            ChartPublishedBar.timeframe == frame, ChartPublishedBar.start.in_(page)))}
        if not snapshots:
            continue
        for bar in db.scalars(select(Bar).where(Bar.instrument_id == instrument_id,
                Bar.timeframe == frame, Bar.start.in_(snapshots))):
            old = snapshots[bar.start]
            row = {**candle_dict(bar.candle()), 'observed_at': bar.observed_at or bar.received_at,
                   'confirmed_at': bar.received_at}
            if content(old.payload) != content(row):
                continue
            if row['observed_at'] > old.payload.get('observed_at', 0):
                old.payload = row
            remaining.discard(bar.start)
    return remaining
