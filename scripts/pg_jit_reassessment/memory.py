"""Fast repeated-inlining control; thresholds are deliberately forced to zero."""

import json

from alerts import storage
from measure import OUT, process_stats


def main():
    query = '''SELECT sum(mod((i+1)::bigint * (i+2)::bigint, 1000003))
               FROM generate_series(1,10) AS s(i)'''
    result = {}
    for mode in ('off', 'on'):
        # Fresh backend for each control: no previous JIT allocator history.
        storage.engine.dispose()
        with storage.engine.connect() as connection:
            for setting in ('jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost'):
                connection.exec_driver_sql(f'SET {setting}=0')
            connection.exec_driver_sql(f'SET jit={mode}')
            pid = connection.exec_driver_sql('SELECT pg_backend_pid()').scalar_one()
            plan = connection.exec_driver_sql(
                'EXPLAIN (ANALYZE,FORMAT JSON) '+query).scalar_one()[0]
            connection.commit()
            if mode == 'on':
                assert plan['JIT']['Options']['Inlining']
                assert plan['JIT']['Options']['Optimization']
            points = []
            for iteration in range(1,1001):
                assert connection.exec_driver_sql(query).scalar_one() == 570
                connection.rollback()
                if iteration in (1,10,50,100,250,500,1000):
                    points.append(dict(iteration=iteration,**process_stats(pid)))
            result[mode] = dict(plan=plan,points=points)
            print('memory_control',mode,json.dumps(points),flush=True)
    (OUT/'memory-control.json').write_text(json.dumps(result,indent=2)+'\n')


if __name__ == '__main__':
    main()
