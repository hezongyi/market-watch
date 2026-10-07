"""Read-only actual Ubuntu cache/reference comparison; prints no credentials."""

import json
import time

from alerts import composite_chart
from alerts.chart_data import FRAMES
from alerts.composite_aggregates import read
from alerts.composite_series import read_window
from alerts.storage import (
    CompositePreparation,
    CompositeRevision,
    MarketComposite,
    now_ms,
    transaction,
)
from sqlalchemy import func, select


def main():
    records = []
    with transaction() as db:
        before = db.scalar(select(func.count()).select_from(MarketComposite))
        for composite in db.scalars(select(MarketComposite).order_by(MarketComposite.id)):
            revision = db.get(CompositeRevision, composite.active_revision_id)
            prep = db.get(CompositePreparation, revision.id)
            stamp = now_ms()
            for frame in FRAMES:
                started = time.monotonic()
                bars = read(db, revision.id, frame, prep.input_revision, before=stamp + 1, count=2000, now=stamp)
                assert bars is not None and bars, (composite.id, frame, "not processed")
                elapsed = (time.monotonic() - started) * 1000
                reference = read_window(db, composite.id, frame, bars[0]["start"], bars[-1]["end"],
                    revision_id=revision.id, input_revision=prep.input_revision, now=stamp)["bars"]
                assert bars == reference, (composite.id, frame, "fixed raw M1 reference differs")
                original = composite_chart.read_window
                def forbidden(*args, **kwargs):
                    raise AssertionError("Persisted chart still reads raw M1")
                try:
                    composite_chart.read_window = forbidden
                    page = composite_chart.chart_page(db, composite.id, frame, count=10,
                        input_revision=prep.input_revision, now=stamp)
                    assert page["materialized"] and page["bounded_partitions"] == 0
                finally:
                    composite_chart.read_window = original
                records.append({"composite_id": composite.id, "revision_id": revision.id,
                    "timeframe": frame, "input_revision": prep.input_revision,
                    "materialized_rows": len(bars), "read_ms": round(elapsed, 2),
                    "raw_input_parity": True, "chart_m1_partitions": 0})
        assert before and db.scalar(select(func.count()).select_from(MarketComposite)) == before
    print(json.dumps({"passed": True, "environment": "Ubuntu market-watch-three-layer",
        "records": records, "read_only": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
