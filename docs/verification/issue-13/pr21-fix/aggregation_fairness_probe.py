"""Real PostgreSQL aggregation/worker fairness after the PR #21 fixes.

Requires this task's isolated TEST_POSTGRES_URL. Every run creates and drops
private schemas; the real clock, worker budget and calculation remain intact.
"""

import json
import os
import time
import uuid
from decimal import Decimal
from pathlib import Path

from alerts import market, storage
from alerts.chart_aggregation import PERIODS, enqueue_aggregation
from alerts.chart_aggregation_worker import cycle, wait_seconds
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker


def scenario(*, sustained):
    schema = 'pr21_aggregation_' + uuid.uuid4().hex
    admin = create_engine(os.environ['TEST_POSTGRES_URL'])
    engine = None
    original = market.aggregate_touched
    events = []

    def observe(db, inst, touched, **kwargs):
        result = original(db, inst, touched, **kwargs)
        events.append((inst.id, kwargs['timeframes'][0]))
        return result

    try:
        with admin.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA {schema}'))
        engine = create_engine(os.environ['TEST_POSTGRES_URL'],
            connect_args={'options': f'-csearch_path={schema}'})
        storage.bootstrap(engine)
        storage.Session = sessionmaker(engine, expire_on_commit=False)
        stamp = storage.now_ms()
        start = (stamp // 86400000 - 60) * 86400000
        identities = ['BTCUSDT', 'EURUSD']
        if sustained:
            identities += [f'PR21-SYNTHETIC-{i}' for i in range(8)]
            with storage.transaction() as db:
                for ident in identities[2:]:
                    db.add(storage.Instrument(id=ident, label=ident, symbol=ident,
                        source='binance', basis='trade', calendar='utc0', precision=2))
        with engine.begin() as conn:
            for ident in identities:
                minutes = 30 * 1440 if ident == 'BTCUSDT' else 1
                for offset in range(0, minutes, 1000):
                    rows = [dict(instrument_id=ident, timeframe='M1',
                        start=start+i*60000, end=start+(i+1)*60000,
                        open=Decimal(10), high=Decimal(11), low=Decimal(9), close=Decimal(10),
                        complete=True, revision=1, received_at=stamp, observed_at=stamp,
                        volume_complete=False, volume_revision=0, volume_received_at=0)
                        for i in range(offset, min(offset+1000, minutes))]
                    conn.execute(storage.Bar.__table__.insert(), rows)
        with storage.transaction() as db:
            for ident in identities:
                db.scalar(select(storage.Instrument).where(
                    storage.Instrument.id == ident).with_for_update())
                enqueue_aggregation(db, ident, start,
                    start+(30*86400000 if ident == 'BTCUSDT' else 60000),
                    stamp-(20000 if ident == 'BTCUSDT' else 15000))
            if sustained:
                db.add(storage.ChartViewportDemand(id='pr21-focus', instrument_id='BTCUSDT',
                    timeframe='M5', start=start, end=start+86400000, warm_start=start,
                    focused=True, expires=stamp+120000))
        market.aggregate_touched = observe
        ready = time.monotonic()
        expected = {(ident, frame) for ident in identities for frame in PERIODS}
        last_service = {key: ready for key in expected}
        first, rounds, turns = {}, {key: 0 for key in expected}, []
        maximum = 0
        while time.monotonic()-ready < (30 if sustained else 12):
            events.clear()
            at = time.monotonic()
            worked, published = cycle()
            done = time.monotonic()
            # Return from cycle includes commit. Count each still-ready target's
            # age before resetting a serviced target, and again at the tail.
            maximum = max(maximum, max(done-value for value in last_service.values()))
            for key in events:
                first.setdefault(key, done-ready)
                last_service[key] = done
                rounds[key] += 1
                if sustained:
                    with storage.transaction() as db:
                        db.scalar(select(storage.Instrument).where(
                            storage.Instrument.id == key[0]).with_for_update())
                        # Preserve all other jobs, including the large backlog.
                        from alerts.source_history_store import _insert
                        db.execute(_insert(db)(storage.ChartAggregationJob).values(
                            instrument_id=key[0], timeframe=key[1], start=start,
                            end=start+60000, created_at=storage.now_ms()
                        ).on_conflict_do_nothing(index_elements=[
                            'instrument_id', 'timeframe', 'start', 'end']))
            turns.append(dict(seconds=done-at, target=events.copy(), at=done-ready))
            if not sustained and all(('EURUSD', frame) in first for frame in PERIODS):
                break
            time.sleep(wait_seconds(worked, published))
        maximum = max(maximum, max(time.monotonic()-value for value in last_service.values()))
        with storage.transaction() as db:
            waiting = db.scalar(select(func.count()).select_from(storage.ChartAggregationJob).where(
                storage.ChartAggregationJob.instrument_id == 'EURUSD'))
            backlog = db.scalar(select(func.count()).select_from(storage.ChartAggregationJob).where(
                storage.ChartAggregationJob.instrument_id == 'BTCUSDT'))
            errors = list(db.scalars(select(storage.ChartAggregationJob.error).where(
                storage.ChartAggregationJob.error.is_not(None))))
        result = dict(scenario='sustained_50_targets' if sustained else 'original_30_day_backlog',
            cpu_max=Path('/sys/fs/cgroup/cpu.max').read_text().strip(),
            memory_max=Path('/sys/fs/cgroup/memory.max').read_text().strip(),
            actual_elapsed_seconds=time.monotonic()-ready, actual_worker_cycles=len(turns),
            targets=len(expected), missing=sorted(expected-first.keys()),
            service=[dict(instrument=key[0], frame=key[1], first_seconds=first.get(key),
                rounds=rounds[key]) for key in sorted(expected)],
            longest_ready_wait_seconds=maximum, eurusd_jobs_remaining=waiting,
            btcusd_jobs_remaining=backlog, calculation_errors=errors, turns=turns,
            calculation='actual market.aggregate_touched and worker cycle; real clock; no mocked calculation')
        if sustained:
            assert not result['missing'] and min(rounds.values()) >= 2, result
            assert maximum <= 10, result
        else:
            assert waiting == 0 and backlog > 0, result
            assert max(first['EURUSD', frame] for frame in PERIODS) <= 10, result
        assert not errors, result
        return result
    finally:
        market.aggregate_touched = original
        if engine is not None:
            engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS {schema} CASCADE'))
        admin.dispose()


if __name__ == '__main__':
    results = [scenario(sustained=False), scenario(sustained=True)]
    target = Path('/results/aggregation-fairness.json')
    target.write_text(json.dumps(results, indent=2)+'\n')
    for result in results:
        print(json.dumps({key: value for key, value in result.items() if key not in ('turns', 'service')}))
