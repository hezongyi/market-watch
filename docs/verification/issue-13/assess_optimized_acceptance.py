"""Assess frozen numeric gates from saved evidence; never adjust limits to results."""
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEW = HERE/os.environ.get('ISSUE13_OUTPUT', 'results/optimized-baseline')
OLD = HERE/'results/v114-baseline'
CONSUMERS = HERE/os.environ.get('ISSUE13_CONSUMER_OUTPUT', 'results/optimized')


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
            if 'final_unserved_ready' in row:
                tail_path=CONSUMERS/'terminal-wait'/f'{scenario}-{i}.json'
                tail=read(tail_path) if tail_path.exists() else None
                resolved=not row['final_unserved_ready'] or tail is not None and (
                    not tail['final_unserved_ready'] and not tail['unpublished_events'] and
                    tail['nominal_input_window_seconds']==300 and tail['drain_limit_seconds']==30 and
                    tail['longest_target_wait']<=10)
                gate(f'{scenario}_{i}_unresolved_runnable_targets',len(row['final_unserved_ready']),0,
                    resolved,'Original censored intervals retained; supplementary same-scenario stop-input drain required')
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
    def consumer(filename):
        path = CONSUMERS/filename
        if not path.exists():
            missing.append(filename)
            return None
        return read(path)
    fairness = consumer('fairness/result.json')
    if fairness:
        gate('fairness_90_targets_first_service_seconds',fairness['longest_first_service_seconds'],10,
            not fairness['missing'] and fairness['longest_first_service_seconds'] <= 10,
            'Ten explicit synthetic identities, nine periods, continuous focused input')
        if 'rounds' in fairness:
            gate('fairness_90_targets_sustained_wait_seconds',fairness['longest_target_wait'],10,
                fairness['longest_target_wait'] <= 10 and min(row['count'] for row in fairness['rounds']) >= 2,
                'All 90 targets remain runnable; repeated service and unserved ages included')
    mixed = consumer('supplemental/mixed.json')
    if mixed:
        for percentile,limit in [('p95',15),('p99',30)]:
            value = mixed['latency_completed_only'][percentile]
            gate('mixed_input_'+percentile+'_seconds',value,limit,value is not None and value <= limit,
                 '20 exact M1 payload inputs, two identities backfilling concurrently')
        gate('mixed_unpublished_before_final30s',mixed['unpublished_before_final30s'],0,
            mixed['unpublished_before_final30s'] == 0,'All ten identities receive new minute + observation')
        gate('mixed_runnable_wait_seconds',mixed['longest_target_wait'],10,
            mixed['longest_target_wait'] <= 10,'Only runnable durable generations included')
        gate('mixed_unresolved_runnable_targets',len(mixed['final_unserved_ready']),0,
             not mixed['final_unserved_ready'],'All terminal runnable targets remain in the acceptance denominator')
    high = consumer('high-period/result.json')
    if high:
        gate('high_period_oracle_cases',high['case_count'],120,
            high['outcome'] == 'passed' and high['case_count'] == 120,'Independent M30/W1/MN arithmetic and consumers')
    observation = consumer('observation-alert/result.json')
    if observation:
        gate('same_price_exact_visibility_judgment_markers',[observation['visible'],observation['judged']],50,
            observation['inputs'] == observation['visible'] == observation['judged'] == 50,
            '50 exact markers over 330s, missed markers remain in denominator')
        for percentile,limit in [('p95',1),('p99',2)]:
            value = observation.get('visible_to_judged_certified_upper',
                observation['visible_to_judged_completed'])[percentile]
            gate('same_price_visible_to_judged_'+percentile+'_seconds',value,limit,
                value is not None and value <= limit,'Sequential PG sampling includes scheduling uncertainty')
        for percentile,limit in [('p95',15),('p99',30)]:
            value = observation['commit_to_visible_completed'][percentile]
            gate('same_price_commit_to_visible_'+percentile+'_seconds',value,limit,
                value is not None and value <= limit,'Same-price M1 input to observed published marker')
    network = consumer('network-alert/result.json')
    normal = consumer('normal-input-alert/result.json')
    if normal:
        gate('normal_input_exact_markers',[normal['inputs'],normal['visible'],normal['judged']],310,
            normal['inputs']==normal['visible']==normal['judged']==310 and not normal['errors'],
            '330s continuous input across ten identities; new minutes and price/volume revisions')
        for percentile,limit in [('p95',1),('p99',2)]:
            value=normal['visible_to_judged_certified_upper'][percentile]
            gate('normal_input_visible_to_judged_'+percentile+'_seconds',value,limit,
                 value is not None and value <= limit,'Conservative visibility and per-alert commit intervals')
    if network:
        for percentile,limit in [('p95',.5),('p99',1)]:
            value = network['api'][percentile]
            gate('tcp_api_'+percentile+'_seconds',value,limit,value is not None and value <= limit,
                 '120 authenticated <=500bar calls alongside publication and alerts; lifespan off')
        for percentile,limit in [('p95',1),('p99',2)]:
            value = network.get('alert_latency_certified_upper',
                network['alert_latency_completed_only'])[percentile]
            gate('trigger_visible_to_judged_'+percentile+'_seconds',value,limit,
                value is not None and value <= limit,'Ten new-minute crossings, exact one signal per input')
        gate('tcp_exact_input_judgment_denominator',[network['visible'],network['judged']],10,
            network['inputs'] == network['visible'] == network['judged'] == 10 and not network['errors'],
            'Exact trigger outcomes with retained visibility/judgment samples')
    browser = consumer('browser/result.json')
    if browser:
        gate('browser_product_flow',browser['outcome'],'passed',browser['outcome'] == 'passed',
            'Built UI/native dual chart/save/reload/full API lifespan, isolated upstream')
        runtime = consumer('browser/services-runtime.json')
        if runtime:
            cpu = sum(row['nanocpus'] for row in runtime if not row['name'].endswith('postgres-1'))/1e9
            gate('app_browser_cpu_limit',cpu,1.5,cpu <= 1.5,'Actual live container cgroup limits; PostgreSQL separate')
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
