"""Saved consumer evidence audit, preserving failures and exact denominators."""
import json
import gzip
import hashlib
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE/os.environ.get('ISSUE13_CONSUMER_OUTPUT','results/optimized')


def read(name):
    return json.loads((ROOT/name).read_text())


def main():
    outputs = []
    terminal=read('terminal-wait/result.json')
    for scenario,repetition in terminal['required']:
        report=read(f'terminal-wait/{scenario}-{repetition}.json')
        raw=[json.loads(line) for line in (ROOT/f'terminal-wait/{scenario}-{repetition}.jsonl').read_text().splitlines()]
        assert report['nominal_input_window_seconds']==300 and report['drain_limit_seconds']==30
        assert not report['unpublished_events'] and not report['final_unserved_ready']
        assert max(row['longest_ready_age'] for row in raw)==report['longest_target_wait']<=10
    assert terminal['completed']==len(terminal['required'])
    outputs.append(dict(scope='censored_wait_supplement',completed=terminal['completed']))
    fairness = read('fairness/result.json')
    assert fairness['targets'] == len(fairness['service']) == 90 and not fairness['missing']
    assert len({(r['instrument'],r['frame']) for r in fairness['service']}) == 90
    outputs.append(dict(scope='fairness',targets=90,seconds=fairness['longest_first_service_seconds']))
    micro = read('consumer-microbaseline.json')
    assert len(micro['api_samples']) == len(micro['alert_samples']) == 120
    assert micro['queries'].get('alert_staging_reads',0) == 0
    assert all(r['bars'] > 0 for r in micro['api_samples'])
    outputs.append(dict(scope='consumer_micro',api=120,evaluate=120))
    mixed = read('supplemental/mixed.json')
    assert len(mixed['events']) == 20 and not mixed['unpublished_events']
    assert not mixed['final_unserved_ready'], 'Mixed workload retains censored runnable targets'
    assert all(v == {'new_bar':1,'observation':1} for v in mixed['inputs_by_identity'].values())
    assert not mixed['lock_sample_errors']
    outputs.append(dict(scope='mixed',inputs=20,exact_payloads=20,terminal_runnable_targets=0))
    high = read('high-period/result.json')
    assert high['outcome'] == 'passed' and high['case_count'] == 120
    assert len(high['phases']) == 4
    assert high['phases'][-1]['snapshot_sha256'] == high['phases'][-2]['snapshot_sha256']
    for phase in high['phases']:
        assert len(phase['cases']) == 30
        assert all(row['chart_csv_mcp_alert_read_equal'] and
                   row['expected_sha256'] == row['actual_sha256'] for row in phase['cases'])
    from high_period_oracle import expected
    def sha(value):
        return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    fixture=json.loads((HERE/os.environ.get('ISSUE13_OUTPUT','results/optimized-baseline')/'fixture.json').read_text())
    for phase in high['phases']:
        raw=gzip.decompress((ROOT/'high-period'/(phase['label']+'-sources.json.gz')).read_bytes())
        assert hashlib.sha256(raw).hexdigest()==phase['source_archive_sha256']
        inputs=json.loads(raw)
        stamp=max(fixture['now'],max(row['observed_at'] for data in inputs.values()
            for rows in data['frames'].values() for row in rows))
        for case in phase['cases']:
            data=inputs[case['instrument']]
            rows=expected(data['frames']['M15' if case['timeframe']=='M30' else 'D1'],
                case['timeframe'],data['meta'],fixture['start'],fixture['now']-5000,stamp)
            assert sha(rows)==case['expected_sha256']
    snapshots=json.loads(gzip.decompress((ROOT/'high-period/final-snapshots.json.gz').read_bytes()))
    assert sha(snapshots)==high['phases'][-1]['snapshot_sha256']
    outputs.append(dict(scope='independent_high_period',cases=120,duplicate_idempotent=True,offline_recomputed=True))
    observation = read('observation-alert/result.json')
    timeline = [json.loads(line) for line in (ROOT/'observation-alert/timeline.jsonl').read_text().splitlines()]
    assert observation['outcome'] == 'passed' and not observation['errors']
    assert observation['inputs'] == observation['visible'] == observation['judged'] == 50
    assert len(timeline) == observation['sample_count']
    from measurement_windows import latency_window
    from supplemental_probe import quantiles
    def check_intervals(report, samples):
        uppers=[]
        for item in report['events']:
            ident,marker=item['instrument'],item['source_observed_at']
            visible=next(r for r in samples if r['identities'][ident]['published_observed_at']==marker)
            assert visible['identities'][ident]['payload']==item['expected_payload']
            judged=next(r for r in report['alert_commits'] if r['alert_id']==item['alert_id'] and r['sequence']==marker)
            absent=[r['query_start_seconds'] for r in samples if
                r['observed_seconds']<visible['observed_seconds'] and
                r['identities'][ident]['published_observed_at']!=marker]
            window=latency_window((max(absent+[item['commit_window_begin_seconds']]),visible['observed_seconds']),
                (judged['commit_started'],judged['committed']))
            assert window==item['latency_interval']
            assert item['visible_seconds']==visible['observed_seconds']
            assert item['judged_seconds']==judged['committed']
            uppers.append(window['upper_seconds'])
        assert report['visible_to_judged_certified_upper']==quantiles(uppers)
    check_intervals(observation,timeline)
    for item in observation['events']:
        ident, marker = item['instrument'],item['source_observed_at']
        visible = next(r for r in timeline if r['identities'][ident]['published_observed_at'] == marker)
        judged = next(r for r in observation['alert_commits'] if
            r['alert_id'] == item['alert_id'] and r['sequence'] == marker)
        assert item['visible_seconds'] == visible['observed_seconds']
        assert item['judged_seconds'] == judged['committed']
    for ident, final in observation['final'].items():
        assert final['count'] == final['signal_count'] == 0
        assert final['source_observed_at'] == final['published_payload']['observed_at'] == final['sequence']
        before = observation['before'][ident]
        stable = lambda r:{k:v for k,v in r.items() if k != 'observed_at'}
        assert stable(final['published_payload']) == stable(before['payload'])
        assert final['source_price_revision'] == before['source_price_revision']
        assert final['source_volume_revision'] == before['source_volume_revision']
        assert final['health'] == 'ready'
    assert observation['queries'].get('alert_staging_reads',0) == 0
    outputs.append(dict(scope='same_price',exact_visible=50,exact_judged=50))
    normal=read('normal-input-alert/result.json')
    assert normal['outcome']=='passed' and not normal['errors']
    assert normal['inputs']==normal['visible']==normal['judged']==310
    assert {'same_price','new_minute','price_revision','volume_revision'} <= {r['kind'] for r in normal['events']}
    normal_timeline=[json.loads(line) for line in (ROOT/'normal-input-alert/timeline.jsonl').read_text().splitlines()]
    assert len(normal_timeline)==normal['sample_count']
    check_intervals(normal,normal_timeline)
    for item in normal['events']:
        row=next(r for r in normal['alert_commits'] if r['alert_id']==item['alert_id']
            and r['sequence']==item['source_observed_at'])
        assert item['judged_seconds']==row['committed'] and item['latency_interval'] is not None
    outputs.append(dict(scope='normal_input',exact_visible=310,exact_judged=310))
    network = read('network-alert/result.json')
    assert not network['errors'] and network['inputs'] == network['visible'] == network['judged'] == 10
    assert network['api']['count'] == len(network['api_samples']) == 120
    assert all(e['final']['count'] == e['final']['signal_count'] == 1 for e in network['events'])
    upper=[]
    for item in network['events']:
        visible,judged=item['visibility'],item['judgment']
        window=latency_window((visible['last_absent_start'],visible['at']),
            (judged['commit_started'],judged['at']))
        assert window==item['latency_interval'] and window['upper_seconds']==item['visible_to_judged_upper']
        upper.append(window['upper_seconds'])
    assert network['alert_latency_certified_upper']==quantiles(upper)
    outputs.append(dict(scope='tcp_and_triggers',api=120,unique_signals=10))
    browser = read('browser/result.json')
    assert browser['outcome'] == 'passed' and not browser['page_errors'] and not browser['failed_requests']
    assert browser['persisted'] == dict(count=2,symbols=['EURUSD','XAUUSD'])
    assert [p['label'] for p in browser['phases']] == ['M1 idle 30s','M5 period switch',
        'EURUSD identity switch','two-chart native layout','manual save','reload persisted layout']
    runtime = read('browser/services-runtime.json')
    assert len(runtime) == 6 and all(r['state']['Running'] for r in runtime)
    assert sum(r['nanocpus'] for r in runtime if not r['name'].endswith('postgres-1')) <= 1500000000
    assert read('browser/network-isolation.json')['internal']
    outputs.append(dict(scope='browser',six_phases=True,actual_services=6))
    with (ROOT/'consumer-artifact-audit.json').open('x') as output:
        json.dump(dict(passed=True,checks=outputs,note='Numeric thresholds assessed separately'),output,indent=2)
        output.write('\n')
    print(json.dumps(outputs,indent=2))


if __name__ == '__main__':
    main()
