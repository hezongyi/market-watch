"""Retract unsupported candidate-calendar completeness in bounded transactions.

This administrative correction preserves every M1 observation and immutable
history/replay input. It applies only to explicit identities without reviewed
closures; their entire UTC minute interval remains potentially open.
"""

from sqlalchemy import func, select
from sqlalchemy.orm import aliased

from .storage import (
    Audit,
    Bar,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    now_ms,
    transaction,
)


def revalidate_page(instrument_id, *, after=0, published=False, limit=500):
    if not 1 <= limit <= 500:
        raise ValueError("Revalidation requires bounded pages")
    with transaction() as db:
        inst = db.scalar(select(Instrument).where(Instrument.id == instrument_id).with_for_update())
        if not inst or not inst.id.startswith("MD:") or inst.calendar_profile:
            raise ValueError("Revalidation requires an explicit unreviewed candidate calendar")
        model = ChartPublishedBar if published else Bar
        minute = aliased(Bar)
        observed_count = select(func.count()).select_from(minute).where(
            minute.instrument_id == inst.id, minute.timeframe == "M1", minute.complete.is_(True),
            minute.start >= model.start, minute.start < model.end).correlate(model).scalar_subquery()
        # Published rows use (timeframe,start), so process one globally ordered
        # UTC start page, including every frame at its last boundary.
        coordinate = model.start if published else model.id
        query = select(model, observed_count).where(model.instrument_id == inst.id,
            model.timeframe != "M1", model.complete.is_(True), coordinate > after).order_by(coordinate)
        if published:
            boundaries = list(db.scalars(select(model.start).where(model.instrument_id == inst.id,
                model.timeframe != "M1", model.complete.is_(True), model.start > after)
                .distinct().order_by(model.start).limit(max(1, limit // 10))))
            rows = list(db.execute(query.where(model.start <= boundaries[-1]))) if boundaries else []
        else:
            rows = list(db.execute(query.limit(limit)))
        affected = []
        for row, observed in rows:
            if observed * 60000 == row.end - row.start:
                continue
            row.complete = False
            row.revision += 1
            if published:
                row.payload = {**row.payload, "complete": False, "volume_complete": False, "volume": None}
                pub = db.get(ChartPublication, (inst.id, row.timeframe))
                if pub:
                    pub.complete_count -= 1
                    pub.revision += 1
                    pub.updated_at = now_ms()
            else:
                row.volume = None
                row.volume_complete = False
                row.volume_revision += 1
                row.received_at = now_ms()
            affected.append({"timeframe": row.timeframe, "start": row.start, "end": row.end})
        if affected:
            db.add(Audit(kind="candidate_completeness_retracted", details={
                "instrument": inst.id, "published": published, "bars": affected,
                "reason": "unreviewed phase cannot certify unobserved minutes as closed"}))
        return {"examined": len(rows), "retracted": len(affected),
                "after": getattr(rows[-1][0], "start" if published else "id") if rows else after}
