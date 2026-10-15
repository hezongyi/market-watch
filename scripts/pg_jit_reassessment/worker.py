"""Measure one real aggregate_once call; roll back each identical input sample."""

import contextlib
import hashlib
import json
import statistics
import time

from alerts import chart_aggregation, storage
from measure import JOBS, NOW, OUT
from sqlalchemy import text
from sqlalchemy.orm import Session


def main():
    original_transaction, original_clock = storage.transaction, storage.now_ms
    samples = {'off': [], 'on': []}
    outputs = {'off': set(), 'on': set()}
    try:
        storage.now_ms = lambda: NOW
        for repetition in range(7):
            for mode in (('off', 'on') if repetition % 2 == 0 else ('on', 'off')):
                with storage.engine.connect() as connection:
                    outer = connection.begin()
                    connection.exec_driver_sql(f'SET LOCAL jit={mode}')
                    with Session(bind=connection) as db:
                        @contextlib.contextmanager
                        def transaction():
                            yield db

                        storage.transaction = transaction
                        started = time.perf_counter()
                        assert chart_aggregation.aggregate_once()
                        elapsed = (time.perf_counter() - started) * 1000
                        assert db.scalar(text('SELECT max(attempts) FROM chart_aggregation_jobs')) == 0
                        assert db.scalar(text('SELECT count(*) FROM chart_aggregation_jobs')) == JOBS
                        rows = db.execute(text('''SELECT instrument_id,timeframe,start,"end",
                            open,high,low,close,complete FROM candles WHERE timeframe <> 'M1'
                            ORDER BY instrument_id,timeframe,start''')).all()
                        assert len(rows) == 8, rows
                        outputs[mode].add(hashlib.sha256(repr(rows).encode()).hexdigest())
                    if outer.is_active:
                        outer.rollback()
                if repetition >= 2:
                    samples[mode].append(elapsed)
                print('worker', repetition, mode, round(elapsed, 3), flush=True)
        assert len(outputs['on']) == len(outputs['off']) == 1
        assert outputs['on'] == outputs['off']
        result = dict(median_ms={mode: statistics.median(values)
                                for mode, values in samples.items()},
                      samples_ms=samples, aggregate_rows=8,
                      result_sha256=next(iter(outputs['on'])))
        (OUT / 'worker-results.json').write_text(json.dumps(result, indent=2) + '\n')
        print('worker_complete', json.dumps(result), flush=True)
    finally:
        storage.transaction, storage.now_ms = original_transaction, original_clock


if __name__ == '__main__':
    main()
