"""Assess frozen numeric gates from saved evidence; never adjust limits to results."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEW = HERE/'results/optimized-baseline'
OLD = HERE/'results/v114-baseline'
CONSUMERS = HERE/'results/optimized'


def read(path):
    return json.loads(path.read_text())


def main():
    if read(NEW/'state.json')['status'] != 'complete':
        raise SystemExit('Optimized measurement suite incomplete')
    results = []
    def gate(name, value, limit, passed, scope):
        results.append(dict(name=name, value=value, limit=limit, passed=bool(passed), scope=scope))
    samples = {scenario:[read(NEW/f'{scenario}-{i}.json') for i in range(1,4)]
               for scenario in ('idle','live','backfill','revision')}
    old = {scenario:[read(OLD/f'{scenario}-{i}.json') for i in range(1,4)] for scenario in samples}
    average = lambda rows, key:sum(row[key] for row in rows)/len(rows)
    cpu = average(samples['idle'], 'process_cpu_percent')
    old_cpu = average(old['idle'], 'process_cpu_percent')
    reduction = 1-cpu/old_cpu
    gate('idle_cpu_percent', cpu, 5, cpu <= 5, '3x300s mean, single-core percent')
    gate('idle_cpu_reduction', reduction, .8, reduction >= .8, 'versus frozen v1.14 mean; recorded host contention')
    sql = sum(row['queries']['total'] for row in samples['idle'])/sum(row['duration'] for row in samples['idle'])
    old_sql = sum(row['queries']['total'] for row in old['idle'])/sum(row['duration'] for row in old['idle'])
    gate('idle_sql_per_second', sql, 2, sql <= 2, 'Timed worker SQL, maintenance separately recorded')
    gate('idle_sql_reduction', 1-sql/old_sql, .9, 1-sql/old_sql >= .9, 'versus frozen v1.14 mean')
    for scenario in ('live','revision'):
        for i, row in enumerate(samples[scenario],1):
            gate(f'{scenario}_{i}_m1_p95_seconds',row['latency_p95'],15,
                row['latency_p95'] is not None and row['latency_p95'] <= 15,'Completed input→M1 visibility')
            gate(f'{scenario}_{i}_m1_p99_seconds',row['latency_p99'],30,
                row['latency_p99'] is not None and row['latency_p99'] <= 30,'Completed input→M1 visibility')
            late = [e for e in row['unpublished_events'] if e['committed_seconds'] <= row['duration']-30]
            gate(f'{scenario}_{i}_unpublished_before_final30s',len(late),0,not late,'Final30s truncation excluded')
    for scenario, rows in samples.items():
        for i,row in enumerate(rows,1):
            gate(f'{scenario}_{i}_runnable_wait_seconds',row['longest_target_wait'],10,
                row['longest_target_wait'] <= 10,'Durable runnable target wait, quiet targets excluded')
    for i,(row,baseline) in enumerate(zip(samples['backfill'],old['backfill']),1):
        throughput = row['backfill_bars_per_second']
        gate(f'backfill_{i}_absolute_bars_per_second',throughput,660.52,throughput >= 660.52,'New effective published bars only')
        gate(f'backfill_{i}_relative_throughput',throughput/baseline['backfill_bars_per_second'],.8,
            throughput >= .8*baseline['backfill_bars_per_second'],'Same seeded fixture and quota; host contention recorded')
    checks = [
        ('consumer-microbaseline.json',lambda r:[
            ('asgi_p95_ms',r['api_latency']['p95']*1000,100),
            ('asgi_p99_ms',r['api_latency']['p99']*1000,200),
            ('evaluate_p95_ms',r['alert_latency']['p95']*1000,200),
            ('evaluate_p99_ms',r['alert_latency']['p99']*1000,350)]),
    ]
    missing = []
    for filename, extract in checks:
        path = CONSUMERS/filename
        if not path.exists():
            missing.append(filename)
            continue
        for name,value,limit in extract(read(path)):
            gate(name,value,limit,value <= limit,'Authenticated 10 identities×4 periods×3 repetitions')
    for filename in ('fairness/result.json','supplemental/mixed.json','high-period/result.json',
                     'observation-alert/result.json','network-alert/result.json','browser/result.json'):
        if not (CONSUMERS/filename).exists():
            missing.append(filename)
    report = dict(results=results,all_assessed_gates_passed=all(row['passed'] for row in results),
        missing=missing,complete_acceptance=False,
        note='Saved-evidence numeric assessment; downstream evidence must be separately audited before Issue13 completion')
    target = CONSUMERS/'numeric-assessment.json'
    with target.open('x') as output:
        json.dump(report,output,indent=2)
        output.write('\n')
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
