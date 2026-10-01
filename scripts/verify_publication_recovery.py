"""Real isolated PostgreSQL aggregation failure/restart and publication rollback.

Copies genuine BTC M1 observations to a temporary fixture identity; injects a
failure after real aggregation writes, proves old snapshots remain readable,
then lets the actual container worker resume. Never changes production data.
"""

import json
import time

from sqlalchemy import delete, select
from verify_dual_recovery import COMPOSE, ROOT, docker, fixture_environment


def main():
    fixture_environment()
    from alerts import chart_aggregation, market
    from alerts.managed_dataset import join, publish_frame, read_rows
    from alerts.storage import (
        Bar,
        Base,
        ChartAggregationJob,
        ChartHistoryPlan,
        ChartPublication,
        Instrument,
        transaction,
    )

    ident = "DUAL_PUBLICATION_PROBE"
    output = ROOT / "docs/verification/dual-container/publication-recovery-live.json"
    evidence = {
        "passed": False,
        "database": "market_watch_dual",
        "fixture": ident,
        "input": "copied genuine BTCUSDT M1 observations",
        "phases": [],
    }
    stopped = False
    original_priority = chart_aggregation.aggregation_priority
    original_aggregate = market.aggregate_touched
    try:
        docker(COMPOSE + "stop chart-aggregation-worker chart-history-worker")
        stopped = True
        with transaction() as db:
            assert db.get(Instrument, ident) is None
            latest = db.scalar(
                select(Bar.end)
                .where(
                    Bar.instrument_id == "BTCUSDT", Bar.timeframe == "M1", Bar.complete.is_(True)
                )
                .order_by(Bar.end.desc())
                .limit(1)
            )
            end = latest // 300000 * 300000
            left, initial_end = end - 15 * 60000, end - 5 * 60000
            observations = list(
                db.scalars(
                    select(Bar)
                    .where(
                        Bar.instrument_id == "BTCUSDT",
                        Bar.timeframe == "M1",
                        Bar.start >= left,
                        Bar.end <= end,
                    )
                    .order_by(Bar.start)
                )
            )
            assert len(observations) == 15
            raw = [
                dict(
                    timestamp=b.start,
                    open=str(b.open),
                    high=str(b.high),
                    low=str(b.low),
                    close=str(b.close),
                )
                for b in observations
            ]
            inst = Instrument(
                id=ident,
                label="isolated publication recovery probe",
                source="binance",
                symbol="BTCUSDT",
                basis="last",
                calendar="utc0",
                precision=2,
            )
            db.add(inst)
            db.flush()
            plan = join(db, inst, left, initial_end + 5000)
            plan.realtime_enabled = False
            plan.status = "cancelled"
            inst.enabled = False
            market.ingest(
                db,
                inst,
                dict(
                    source="binance",
                    basis="last",
                    rows=raw[:10],
                    coverage=[dict(start=left, end=initial_end)],
                ),
                received_at=initial_end + 5000,
            )
            publish_frame(db, inst, plan, "M5", initial_end + 5000)
            baseline = read_rows(db, inst, "M5", end + 300000, 100)
            assert len(baseline) == 2
            baseline_revision = db.get(ChartPublication, (ident, "M5")).revision
        evidence["phases"].append(
            {"phase": "baseline", "published_bars": 2, "revision": baseline_revision}
        )
        with transaction() as db:
            inst = db.get(Instrument, ident)
            market.ingest(
                db,
                inst,
                dict(
                    source="binance",
                    basis="last",
                    rows=raw[10:],
                    coverage=[dict(start=initial_end, end=end)],
                ),
                received_at=end + 5000,
                defer_aggregation=True,
            )
            publish_frame(db, inst, db.get(ChartHistoryPlan, ident), "M5", end + 5000)
            assert read_rows(db, inst, "M5", end + 300000, 100) == baseline

        def select_probe(job, demands):
            return (
                (-1, 0, 0, job.id)
                if job.instrument_id == ident and job.timeframe == "M5"
                else original_priority(job, demands)
            )

        def interrupted(db, inst, touched, **kwargs):
            original_aggregate(db, inst, touched, **kwargs)
            if inst.id == ident:
                raise RuntimeError("intentional post-write aggregation failure")

        chart_aggregation.aggregation_priority = select_probe
        market.aggregate_touched = interrupted
        assert chart_aggregation.aggregate_once()
        market.aggregate_touched = original_aggregate
        chart_aggregation.aggregation_priority = original_priority
        with transaction() as db:
            job = db.scalar(
                select(ChartAggregationJob).where(
                    ChartAggregationJob.instrument_id == ident,
                    ChartAggregationJob.timeframe == "M5",
                )
            )
            assert job.attempts == 1 and job.error == "RuntimeError"
            inst = db.get(Instrument, ident)
            publish_frame(db, inst, db.get(ChartHistoryPlan, ident), "M5", end + 5000)
            assert read_rows(db, inst, "M5", end + 300000, 100) == baseline
            assert db.get(ChartPublication, (ident, "M5")).revision == baseline_revision
            job.next_at = 0
        evidence["phases"].append(
            {
                "phase": "aggregation-failed",
                "attempts": 1,
                "old_snapshot_unchanged": True,
                "retry_persisted": True,
            }
        )
        docker(COMPOSE + "start chart-aggregation-worker")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            with transaction() as db:
                rows = read_rows(db, db.get(Instrument, ident), "M5", end + 300000, 100)
                if len(rows) == 3:
                    assert rows[:2] == baseline
                    assert rows[-1]["end"] == end and rows[-1]["complete"]
                    break
            time.sleep(0.5)
        else:
            raise AssertionError("restarted container worker did not finish the persisted slice")
        docker(COMPOSE + "stop chart-aggregation-worker")
        with transaction() as db:
            before = read_rows(db, db.get(Instrument, ident), "M5", end + 300000, 100)
            revision = db.get(ChartPublication, (ident, "M5")).revision
        try:
            with transaction() as db:
                inst = db.get(Instrument, ident)
                plan = db.get(ChartHistoryPlan, ident)
                publication = db.get(ChartPublication, (ident, "M5"))
                publication.end = end - 300000
                publication.revision += 100
                db.flush()
                publish_frame(db, inst, plan, "M5", end + 5000)
                db.flush()
                raise RuntimeError("intentional interruption before publication commit")
        except RuntimeError:
            pass
        with transaction() as db:
            assert read_rows(db, db.get(Instrument, ident), "M5", end + 300000, 100) == before
            assert db.get(ChartPublication, (ident, "M5")).revision == revision
        evidence["phases"].append(
            {
                "phase": "container-restart-and-publication-rollback",
                "published_bars": 3,
                "no_duplicates": True,
                "original_bars_unchanged": True,
                "publication_transaction_rollback": True,
            }
        )
        evidence["passed"] = True
    finally:
        market.aggregate_touched = original_aggregate
        chart_aggregation.aggregation_priority = original_priority
        if stopped:
            docker(COMPOSE + "stop chart-aggregation-worker")
            with transaction() as db:
                for table in reversed(Base.metadata.sorted_tables):
                    if "instrument_id" in table.c:
                        db.execute(delete(table).where(table.c.instrument_id == ident))
                db.execute(delete(Instrument).where(Instrument.id == ident))
            docker(COMPOSE + "start chart-aggregation-worker chart-history-worker")
        output.write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
