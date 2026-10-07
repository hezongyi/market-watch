"""Persist affected published buckets alongside bounded staging writes."""

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .chart_data import bounds
from .domain import bucket_bounds, calendar_for
from .storage import ChartPublication, ChartPublicationJob, Instrument, instant, ms


def enqueue_publication(db, instrument_id, source, starts):
    if not starts:
        return
    frames = (source, "M30") if source == "M15" else (source, "W1", "MN") if source == "D1" else (source,)
    publications = list(db.scalars(select(ChartPublication).where(
        ChartPublication.instrument_id == instrument_id,
        ChartPublication.timeframe.in_(frames),
    )))
    if not publications:
        return
    inst = db.get(Instrument, instrument_id)
    calendar = calendar_for(inst)
    values = {}
    for pub in publications:
        for start in starts:
            left, right = (bounds if pub.timeframe in ("M30", "W1", "MN") else bucket_bounds)(
                instant(start), pub.timeframe, calendar
            )
            left, right = ms(left), ms(right)
            # Edges not yet published are already handled by bounded backfill.
            if pub.start <= left < pub.end:
                values[(pub.timeframe, left)] = dict(
                    instrument_id=instrument_id, timeframe=pub.timeframe, start=left, end=right
                )
    if values:
        insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        db.execute(insert(ChartPublicationJob).values(list(values.values())).on_conflict_do_nothing(
            index_elements=["instrument_id", "timeframe", "start"]
        ))
