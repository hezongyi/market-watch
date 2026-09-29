"""Bounded, revision-aware batch persistence shared by imports and live ingestion."""

from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .storage import Audit, Bar, candle_dict, ms, now_ms


def write_bars(db, instrument_id, timeframe, candles):
    # Last occurrence wins, matching the previous sequential upsert contract.
    unique = {ms(c.start): c for c in candles}
    if not unique:
        return
    dialect = db.get_bind().dialect.name
    insert = pg_insert if dialect == "postgresql" else sqlite_insert
    keys = ("open", "high", "low", "close", "complete")
    entries = list(unique.items())
    for offset in range(0, len(entries), 500):
        batch = entries[offset : offset + 500]
        old = {
            row.start: row
            for row in db.scalars(
                select(Bar).where(
                    Bar.instrument_id == instrument_id,
                    Bar.timeframe == timeframe,
                    Bar.start.in_([start for start, _ in batch]),
                )
            )
        }
        stamp = now_ms()
        values = []
        for start, candle in batch:
            row = old.get(start)
            if row and any(getattr(row, k) != getattr(candle, k) for k in keys):
                db.add(
                    Audit(
                        kind="candle_revision",
                        details={
                            "instrument": instrument_id,
                            "timeframe": timeframe,
                            "previous": candle_dict(row.candle()),
                        },
                    )
                )
            values.append(
                {
                    "instrument_id": instrument_id,
                    "timeframe": timeframe,
                    "start": start,
                    "end": ms(candle.end),
                    **{k: getattr(candle, k) for k in keys},
                    "revision": 1,
                    "received_at": stamp,
                }
            )
        statement = insert(Bar).values(values)
        statement = statement.on_conflict_do_update(
            index_elements=[Bar.instrument_id, Bar.timeframe, Bar.start],
            set_={
                **{k: getattr(statement.excluded, k) for k in keys},
                "end": statement.excluded.end,
                "revision": Bar.revision + 1,
                "received_at": stamp,
            },
            where=or_(*(getattr(Bar, k) != getattr(statement.excluded, k) for k in keys)),
        )
        db.execute(statement)
        # ORM callers in this transaction must not see stale revision/value state.
        for row in old.values():
            db.expire(row)
    db.flush()
