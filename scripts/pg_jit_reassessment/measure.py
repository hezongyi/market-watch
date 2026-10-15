"""Bounded PG14 JIT comparison using SQL emitted by the actual application.

Synthetic fixtures only; no supplier requests, production data or credentials.
Run with the adjacent isolated Compose file. Results are written to /results.
"""

import contextlib
import hashlib
import json
import os
import statistics
import time
from pathlib import Path

from alerts import chart_aggregation, market, storage
from sqlalchemy import select, text

OUT = Path('/results')
NOW = 1792022400000  # Fixed clock: 2026-10-15 00:00 UTC.
BASE = NOW - 86400000
INSTRUMENTS = 139
JOBS = 60761


class Captured(BaseException):
    pass


def emitted_queries(engine):
    """Capture the real builders at their execution boundary, without copying SQL."""
    result = {}

    class SchedulerProbe:
        def execute(self, statement):
            result['scheduler'] = statement
            raise Captured()

    @contextlib.contextmanager
    def transaction():
        yield SchedulerProbe()

    original_transaction, original_clock = storage.transaction, storage.now_ms
    storage.transaction, storage.now_ms = transaction, lambda: NOW
    try:
        chart_aggregation.aggregate_once()
    except Captured:
        pass
    finally:
        storage.transaction, storage.now_ms = original_transaction, original_clock

    inst = storage.Instrument(id='BENCH000', label='synthetic', source='binance',
        symbol='BTCUSDT', basis='bid', calendar='utc0', calendar_profile={}, precision=6)

    class MinuteProbe:
        def scalar(self, statement):
            return inst

        def scalars(self, statement):
            result['minute_read'] = statement
            raise Captured()

    original_coverage = market.stored_coverage
    market.stored_coverage = lambda *args: []
    try:
        market.aggregate_touched(MinuteProbe(), inst, {storage.instant(BASE)},
                                 received_at=NOW, timeframes=('D1',))
    except Captured:
        pass
    finally:
        market.stored_coverage = original_coverage

    sql = {name: str(stmt.compile(engine, compile_kwargs={'literal_binds': True}))
           for name, stmt in result.items()}
    assert set(sql) == {'scheduler', 'minute_read'}
    for name, statement in sql.items():
        (OUT / f'{name}.sql').write_text(statement + ';\n')
    return sql


def fixture(engine):
    storage.Base.metadata.create_all(engine)
    with engine.begin() as conn:
        # This database belongs exclusively to this task; refuse accidental reuse.
        assert conn.scalar(text('SELECT current_database()')) == 'jit_assessment'
        if conn.scalar(select(storage.Instrument.id).limit(1)) is not None:
            assert conn.scalar(text('SELECT count(*) FROM instruments')) == INSTRUMENTS
            assert conn.scalar(text('SELECT count(*) FROM chart_aggregation_jobs')) == JOBS
            conn.exec_driver_sql('DELETE FROM chart_viewport_demands')
            conn.exec_driver_sql(f'UPDATE chart_aggregation_jobs SET created_at={NOW-60000}')
            conn.exec_driver_sql('ANALYZE chart_viewport_demands')
            conn.exec_driver_sql('ANALYZE chart_aggregation_jobs')
            return
        conn.execute(storage.Instrument.__table__.insert(), [dict(
            id=f'BENCH{i:03}', label=f'Synthetic {i}', source='binance',
            symbol=f'BENCH{i:03}', basis='bid', calendar='utc0', precision=6)
            for i in range(INSTRUMENTS)])
        conn.execute(storage.ChartAggregationState.__table__.insert(), [dict(
            instrument_id=f'BENCH{i:03}', timeframe=frame, last_service_seq=i)
            for i in range(INSTRUMENTS) for frame in chart_aggregation.PERIODS])
        conn.execute(text('''INSERT INTO chart_aggregation_jobs
            (id,instrument_id,timeframe,start,"end",created_at,attempts,next_at,kind)
            SELECT lpad(i::text, 32, '0'), 'BENCH' || lpad((i % 139)::text,3,'0'),
              (ARRAY['M5','M15','H1','H4','D1'])[1 + ((i / 139) % 5)],
              :base + (i / 695) * 86400000::bigint,
              :base + (i / 695 + 1) * 86400000::bigint,
              :now - 60000, 0, 0, 'price'
            FROM generate_series(0,:jobs-1) AS g(i)'''),
            dict(base=BASE, now=NOW, jobs=JOBS))
        conn.execute(text('''INSERT INTO candles
            (instrument_id,timeframe,start,"end",open,high,low,close,complete,
             revision,received_at,observed_at,volume_complete,volume_received_at,volume_revision)
            SELECT 'BENCH'||lpad(inst::text,3,'0'),'M1',:base+m*60000::bigint,
              :base+(m+1)*60000::bigint,100,102,99,101,true,1,:now,0,false,0,0
            FROM generate_series(0,138) AS a(inst)
            CROSS JOIN generate_series(0,1439) AS b(m)'''), dict(base=BASE, now=NOW))
    with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as conn:
        conn.exec_driver_sql('ANALYZE')


def process_stats(pid):
    status = Path(f'/proc/{pid}/status').read_text().splitlines()
    result = {line.split(':')[0]: int(line.split()[1]) for line in status
              if line.startswith(('VmRSS:', 'VmHWM:'))}
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    result['cpu_seconds'] = (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
    return result


def explain(connection, sql, mode):
    connection.exec_driver_sql(f'SET LOCAL jit={mode}')
    return connection.exec_driver_sql(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql).scalar_one()[0]


def compare(engine, sql, name, repetitions=7):
    samples = {'off': [], 'on': []}
    digests = {'off': set(), 'on': set()}
    plans = {}
    # Alternate order to reduce cache/order bias. Warm each mode before sampling.
    for index in range(repetitions + 2):
        for mode in (('off','on') if index % 2 == 0 else ('on','off')):
            with engine.connect() as conn:
                started = time.perf_counter()
                plan = explain(conn, sql, mode)
                wall = (time.perf_counter() - started) * 1000
                rows = conn.exec_driver_sql(sql).fetchall()
                digest = hashlib.sha256(repr([tuple(row) for row in rows]).encode()).hexdigest()
                digests[mode].add(digest)
                conn.rollback()  # FOR UPDATE locks never escape a sample.
            plans[mode] = plan
            if index >= 2:
                samples[mode].append(dict(execution_ms=plan['Execution Time'],
                    planning_ms=plan['Planning Time'], explain_wall_ms=wall,
                    jit_ms=plan.get('JIT',{}).get('Timing',{}).get('Total',0)))
    assert len(digests['off']) == len(digests['on']) == 1
    assert digests['off'] == digests['on'], 'JIT changed query results'
    result = {mode: dict(median_execution_ms=statistics.median(
        row['execution_ms'] for row in samples[mode]),
        median_jit_ms=statistics.median(row['jit_ms'] for row in samples[mode]),
        jit_options=plans[mode].get('JIT',{}).get('Options'), samples=samples[mode])
        for mode in ('off','on')}
    result['on_over_off'] = result['on']['median_execution_ms'] / result['off']['median_execution_ms']
    (OUT / f'{name}-plans.json').write_text(json.dumps(plans, indent=2))
    print(name, json.dumps({k:v for k,v in result.items() if k == 'on_over_off'}), flush=True)
    return result


def soak(engine, sql, mode, iterations=60):
    # One persistent backend specifically exercises repeated JIT compilation.
    with engine.connect() as conn:
        pid = conn.exec_driver_sql('SELECT pg_backend_pid()').scalar_one()
        conn.commit()
        points = []
        for i in range(iterations):
            conn.exec_driver_sql(f'SET LOCAL jit={mode}')
            conn.exec_driver_sql(sql).fetchall()
            conn.rollback()
            if i in (0, 9, 19, 39, 59):
                points.append(dict(iteration=i+1, **process_stats(pid)))
        return points


def main():
    engine = storage.engine
    with engine.connect() as conn:
        metadata = dict(conn.exec_driver_sql('''SELECT
            current_setting('server_version') AS server_version,
            current_setting('server_version_num') AS server_version_num,
            current_setting('jit') AS jit, pg_jit_available() AS jit_available,
            current_setting('jit_above_cost') AS jit_above_cost,
            current_setting('jit_inline_above_cost') AS jit_inline_above_cost,
            current_setting('jit_optimize_above_cost') AS jit_optimize_above_cost
            ''').mappings().one())
        assert metadata['server_version_num'] == '140024', metadata
        assert metadata['jit_available'], metadata
        conn.exec_driver_sql("SET statement_timeout='15s'")
        conn.commit()
    print('metadata', json.dumps(metadata), flush=True)
    sql = emitted_queries(engine)
    fixture(engine)
    result = dict(metadata=metadata, instruments=INSTRUMENTS, jobs=JOBS,
                  candles=INSTRUMENTS*1440, workloads={})
    result['workloads']['aged_queue_empty_demand'] = compare(engine, sql['scheduler'], 'aged-queue')
    result['workloads']['minute_read'] = compare(engine, sql['minute_read'], 'minute-read')
    (OUT / 'partial-results.json').write_text(json.dumps(result,indent=2)+'\n')
    with engine.begin() as conn:
        conn.execute(storage.ChartViewportDemand.__table__.insert(), [dict(
            id=f'demand{i}',instrument_id=f'BENCH{i:03}',timeframe='M15',
            start=BASE,end=NOW,warm_start=BASE,focused=i % 2 == 0,expires=NOW+60000)
            for i in range(40)])
        conn.exec_driver_sql(f'UPDATE chart_aggregation_jobs SET created_at={NOW-1000}')
    with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as conn:
        conn.exec_driver_sql('ANALYZE chart_viewport_demands')
        conn.exec_driver_sql('ANALYZE chart_aggregation_jobs')
    result['workloads']['fresh_queue_active_demand'] = compare(engine, sql['scheduler'], 'fresh-queue')
    (OUT / 'partial-results.json').write_text(json.dumps(result,indent=2)+'\n')
    analytics = '''SELECT sum((mod(i,1000)::double precision * 1.000001 +
        sqrt((mod(i,997) + 1)::double precision)) / (mod(i,97) + 1))
        FROM generate_series(1,3000000) AS t(i)'''
    (OUT / 'analytical-control.sql').write_text(analytics + ';\n')
    result['workloads']['synthetic_analytical_control'] = compare(engine, analytics, 'analytical-control',5)
    (OUT / 'partial-results.json').write_text(json.dumps(result,indent=2)+'\n')
    result['soak'] = {}
    for mode in ('off','on'):
        print('soak',mode,flush=True)
        result['soak'][mode] = soak(engine,sql['scheduler'],mode)
    (OUT / 'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print('complete',json.dumps(result['soak']),flush=True)


if __name__ == '__main__':
    main()
