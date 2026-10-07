"""Audit actual raw measurements before accepting a baseline report.

Available files can be audited while a suite is live; --complete additionally
requires all 12 terminal outputs. Never infers completion from filenames alone.
"""
import argparse
import json
from collections import Counter
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results'
SCENARIOS=('idle','live','backfill','revision')


def read(path):
    return json.loads(path.read_text())


def audit(scenario,repetition):
    name=f'{scenario}-{repetition}'
    result=read(ROOT/(name+'.json'))
    raw=[json.loads(line) for line in (ROOT/(name+'.jsonl')).read_text().splitlines()]
    statistics=read(ROOT/(name+'-sql.json'))
    assert result['scenario']==scenario and result['repetition']==repetition,name
    assert result['duration']>=300,name+' insufficient observation duration'
    assert result['cycles']==len(raw) and raw,name+' missing turns'
    assert raw[-1]['queries']==result['queries'],name+' SQL counter mismatch'
    assert all(a['at']<b['at'] for a,b in zip(raw,raw[1:])),name+' nonmonotonic clock'
    assert all(r['at']<=result['duration'] and r['seconds']>=0 for r in raw),name+' invalid timing'
    assert all(a['queries']['total']<=b['queries']['total'] for a,b in zip(raw,raw[1:])),name+' SQL counter reset'
    expected={(i,f) for i in read(ROOT/'fixture.json')['identities'] for f in ('M1','M5','M15','M30','H1','H4','D1','W1','MN')}
    targets=Counter(tuple(r['target']) for r in raw)
    assert set(targets)<=expected,name+' unexpected target identity'
    # No minimum target coverage is silently declared passed; slower/backlogged
    # baselines may genuinely not finish one rotation and are reported below.
    assert abs(max(r['target_wait'] for r in raw)-result['longest_target_wait'])<1e-8,name+' wait mismatch'
    assert abs(100*result['process_cpu_seconds']/result['duration']-result['process_cpu_percent'])<1e-8,name+' CPU mismatch'
    assert statistics['statements'],name+' no PostgreSQL query evidence'
    assert all(q['calls']>0 and q['rows']>=0 and q['total_exec_time']>=0 for q in statistics['statements']),name+' invalid PG stats'
    completed,pending=result['events'],result['unpublished_events']
    for e in completed+pending:
        assert e['instrument'] in {i for i,_ in expected},name+' unexpected event identity'
        assert 0<=e['committed_seconds']<=result['duration'],name+' invalid commit time'
    assert all(e['latency_seconds']>=0 for e in completed),name+' invalid event latency'
    assert scenario in ('live','revision') or not (completed or pending),name+' unexpected inputs'
    if scenario=='idle':
        assert result['visible_unchanged'] and result['before']==result['after'],name+' visible state changed'
        assert not result['before']['aggregation_jobs'] and not result['before']['publication_jobs'],name+' nonidle queue'
    if scenario=='backfill':
        assert result['after']['published_bars']>=result['before']['published_bars'],name+' regressed backfill'
    eligible=[e for e in completed+pending if e['committed_seconds']<=result['duration']-30]
    overdue=[e for e in pending if e['committed_seconds']<=result['duration']-30]
    return dict(run=name,cycles=len(raw),targets_observed=len(targets),targets_expected=len(expected),
        absent_targets=sorted(expected-set(targets)),minimum_turns=min(targets.values()),maximum_turns=max(targets.values()),
        price_observation_events=dict(Counter(e['kind'] for e in completed+pending)),inputs=len(completed)+len(pending),
        published=len(completed),unpublished=len(pending),eligible_before_final30s=len(eligible),unpublished_before_final30s=len(overdue),
        source_select_returned_rows=sum(q['rows'] for q in statistics['statements'] if 'FROM candles' in q['query']),
        scope='Artifact and numerical consistency only; does not prove payload equality, source completeness or full correctness')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--complete',action='store_true')
    args=parser.parse_args()
    output=[]
    missing=[]
    for scenario in SCENARIOS:
        for rep in range(1,4):
            if not (ROOT/f'{scenario}-{rep}.json').exists():
                missing.append(f'{scenario}-{rep}')
                continue
            output.append(audit(scenario,rep))
    if args.complete:
        assert not missing,'incomplete baseline: '+','.join(missing)
        assert 'SUITE COMPLETE' in (ROOT/'suite.log').read_text(),'suite process did not finish'
    name='measurement-audit.json' if args.complete else 'measurement-audit-interim.json'
    (ROOT/name).write_text(json.dumps(dict(complete=not missing,runs=output,missing=missing),indent=2)+'\n')
    print(json.dumps(dict(audited=len(output),required=12,missing=missing),indent=2))


if __name__=='__main__': main()
