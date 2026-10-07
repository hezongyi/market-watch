"""Offline recomputation and corruption detection for the P0 high-period oracle."""
import copy
import gzip
import hashlib
import json
from collections import Counter
from pathlib import Path

from high_period_oracle import expected

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results/high-period'


def sha(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def check(snapshots, expected_rows):
    for key, rows in expected_rows.items():
        actual=snapshots[key]
        assert [row['payload'] for row in actual['rows']]==rows, key+' payload mismatch'
        assert actual['publication']['complete_count']==sum(row['complete'] for row in rows), key+' complete_count mismatch'


def main():
    result=json.loads((ROOT/'result.json').read_text())
    fixture=json.loads((HERE/'results/fixture.json').read_text())
    assert result['outcome']=='passed' and result['case_count']==120
    expected_by_phase={}
    summaries=[]
    for phase in result['phases']:
        label=phase['label']
        raw=gzip.decompress((ROOT/(label+'-sources.json.gz')).read_bytes())
        assert hashlib.sha256(raw).hexdigest()==phase['source_archive_sha256']
        inputs=json.loads(raw)
        assert len(inputs)==10
        begin=fixture['start']
        stop=fixture['now']-5000
        assert min(row['start'] for row in inputs['BTCUSDT']['frames']['M15'])==begin
        observation=max(row['observed_at'] for data in inputs.values() for rows in data['frames'].values() for row in rows)
        now=max(stop+5000,observation)
        folded={}
        for case in phase['cases']:
            ident, frame=case['instrument'],case['timeframe']
            key=ident+'/'+frame
            assert key not in folded
            data=inputs[ident]
            folded[key]=expected(data['frames']['M15' if frame=='M30' else 'D1'],frame,
                data['meta'],begin,stop,now)
            assert sha(folded[key])==case['expected_sha256']==case['actual_sha256']
            assert case['rows']==len(folded[key])
            assert case['complete_rows']==sum(row['complete'] for row in folded[key])
        assert len(folded)==30
        expected_by_phase[label]=folded
        summaries.append(dict(phase=label,rows=sum(len(rows) for rows in folded.values()),
            targets=len(folded),pages=sum(case['pages'] for case in phase['cases'])))
    snapshots=json.loads(gzip.decompress((ROOT/'final-snapshots.json.gz').read_bytes()))
    assert sha(snapshots)==result['phases'][-1]['snapshot_sha256']
    final=expected_by_phase['duplicate']
    check(snapshots,final)
    # Prove the verifier rejects observable snapshot corruption, rather than
    # merely accepting results produced by the same aggregation implementation.
    probes=[]
    key='BTCUSDT/M30'
    for field in ['end','open','high','low','close','volume','complete','volume_complete','revision','observed_at']:
        corrupt=copy.deepcopy(snapshots)
        row=corrupt[key]['rows'][0]['payload']
        if isinstance(row[field],bool):row[field]=not row[field]
        elif isinstance(row[field],int):row[field]+=1
        else:row[field]='999999'
        try:check(corrupt,final)
        except AssertionError:probes.append(field)
        else:raise AssertionError('Verifier accepted corrupt '+field)
    corrupt=copy.deepcopy(snapshots)
    corrupt[key]['rows'].pop(0)
    try:check(corrupt,final)
    except AssertionError:probes.append('missing_row')
    else:raise AssertionError('Verifier accepted missing row')
    corrupt=copy.deepcopy(snapshots)
    corrupt[key]['publication']['complete_count']+=1
    try:check(corrupt,final)
    except AssertionError:probes.append('complete_count')
    else:raise AssertionError('Verifier accepted corrupt count')
    diffs=Counter()
    for key, rows in expected_by_phase['initial'].items():
        revised=expected_by_phase['revised'][key]
        assert [row['start'] for row in rows]==[row['start'] for row in revised]
        for before,after in zip(rows,revised):
            diffs.update(field for field in before if before[field]!=after[field])
    for field in ('open','high','low','close','volume','volume_complete','revision','observed_at'):
        assert diffs[field]>0, 'No actual changed '+field+' coverage'
    for key, rows in expected_by_phase['revised'].items():
        for before,after in zip(rows,expected_by_phase['observation'][key]):
            assert all(before[field]==after[field] for field in before if field!='observed_at'), 'Observation changed non-observation field'
    assert expected_by_phase['duplicate']==expected_by_phase['observation']
    assert result['phases'][-1]['snapshot_sha256']==result['phases'][-2]['snapshot_sha256']
    state=json.loads((ROOT/'postgres-stopped.json').read_text())
    assert state==dict(running=False,exit=0,oom=False)
    report=dict(passed=True,phases=summaries,changed_payload_fields=dict(diffs),
        corruption_rejected=probes,final_snapshot_rows=sum(len(rows) for rows in final.values()),
        final_snapshot_sha256=sha(snapshots),
        scope='Recompute all four oracle phases offline; full actual PG snapshot preserved for final phase only',
        limitations=['Earlier actual snapshots preserved as equality hashes/assertions, not complete raw payload archives',
            'Consumer responses checked during execution; no full ASGI/CSV/MCP response archive',
            'Corruption checks mutate copies only, not live product data'])
    (ROOT/'artifact-audit.json').write_text(json.dumps(report,indent=2)+'\n')
    print('High-period audit passed: 120 recomputed cases, final PG snapshot, 12 rejected corruptions')


if __name__=='__main__':
    main()
