"""Actual Ubuntu fixed artifact parity; bounded sample, no source fallback."""

import json
import time

from alerts.chart_api import DataQuery, data_sync
from alerts.chart_indicators import calculate
from alerts.fixed_indicators import _context, gap_before, indicator_tick
from alerts.history_artifacts import read_artifact
from alerts.storage import FixedIndicatorRun, MarketComposite, now_ms, transaction
from sqlalchemy import select

SPECS = [{"name": name} for name in ("SMA", "EMA", "LWMA", "BBANDS", "RSI", "MACD", "ATR", "STOCH")]


def main():
    records = []
    with transaction() as db:
        composites = [(row.id, row.active_revision_id) for row in db.scalars(select(MarketComposite))]
    for composite, revision in composites:
        query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", limit=2000,
                          indicators=SPECS, provisional=False, composite_revision_id=revision)
        initial = data_sync(query)
        query.input_revision = initial["input_revision"]
        ids = [item["run_id"] for item in initial["indicator_progress"]]
        for ident in ids:
            for _ in range(120):
                indicator_tick(ident)
                with transaction() as db:
                    run = db.get(FixedIndicatorRun, ident)
                    ready = run.status == "complete"
                    error = run.error
                assert not error, (ident, error)
                if ready:
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("Indicator progress failed to terminate")
        page = data_sync(query)
        assert all(item["status"] == "complete" for item in page["indicator_progress"]), page["indicator_progress"]
        with transaction() as db:
            run = db.get(FixedIndicatorRun, ids[0])
            version, rev, phase, profiles = _context(db, run)
            from alerts.composite_aggregates import read
            from alerts.composite_series import period

            seam_bucket = period(rev.seam, "M1", phase)[0]
            before = read_artifact(db, version.id, "M1", end=seam_bucket, limit=20000)
            assert len(before) < 20000, "Verifier full-prefix sample exceeded bound"
            tail = read(db, revision, "M1", query.input_revision, after=seam_bucket,
                        before=run.target_end, count=20000, now=now_ms(), newest_first=False)
            assert tail is not None and len(tail) < 20000, "Verifier full tail sample exceeded bound"
            rows = {row["start"]: row for row in [*before, *tail]}
            rows = [rows[start] for start in sorted(rows)]
            previous = None
            for row in rows:
                row["gap_before"] = gap_before(previous, row["start"], phase, profiles)
                previous = row["end"]
        for spec, result in zip(SPECS, page["indicators"]):
            expected = calculate(rows, spec)
            for actual, reference in zip(result["series"], expected["series"]):
                values = {row["time"]: row["value"] for row in reference["values"]}
                for row in actual["values"]:
                    if values[row["time"]] is None:
                        assert row["value"] is None
                    else:
                        assert abs(row["value"] - values[row["time"]]) < 1e-8
            records.append({"composite_id": composite, "revision_id": revision, "input_revision": query.input_revision,
                            "name": spec["name"], "full_prefix_rows": len(rows), "full_origin_talib_parity": True})
    assert records
    print(json.dumps({"passed": True, "environment": "Ubuntu market-watch-three-layer", "records": records}))


if __name__ == "__main__":
    main()
