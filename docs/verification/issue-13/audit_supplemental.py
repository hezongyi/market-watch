"""Validate saved supplemental evidence without touching the database."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent/'results'/'supplemental'


def audit():
    reports={}
    for scenario in ('idle','mixed'):
        row=json.loads((ROOT/(scenario+'.json')).read_text())
        turns=[json.loads(line) for line in (ROOT/(scenario+'.jsonl')).read_text().splitlines()]
        assert row['duration']>=300 and row['cycles']==len(turns)>0
        assert all(a['at']<z['at'] for a,z in zip(turns,turns[1:]))
        assert turns[-1]['queries']==row['queries']
        targets={tuple(t['target']) for t in turns}
        assert targets=={(ident,frame) for ident in ('EURUSD','XAUUSD','BTCUSDT')+tuple(f'SYNTH{i:02}' for i in range(7))
            for frame in ('M1','M5','M15','M30','H1','H4','D1','W1','MN')}
        locks=json.loads((ROOT/(scenario+'-locks.json')).read_text())
        assert not locks['errors'] and len(locks['samples'])==row['lock_sample_count']>0
        assert len(row['before']['sha256'])==len(row['after']['sha256'])==64
        assert (ROOT/(scenario+'-sql.json')).exists()
        if scenario=='idle':
            assert row['payload_unchanged'] and row['visible_metadata_unchanged']
            assert not row['events'] and not row['unpublished_events']
            assert sum(row['before']['counts'].values())==row['before_state']['published_bars']
        else:
            inputs=row['events']+row['unpublished_events']
            assert len(inputs)==20
            assert all(value=={'new_bar':1,'observation':1} for value in row['inputs_by_identity'].values())
            assert all(item['expected_payload']['observed_at']>=item['expected_payload']['end']+5000 for item in inputs)
            assert all(item['latency_seconds']>=0 for item in row['events'])
        reports[scenario]=dict(cycles=len(turns),targets=len(targets),lock_samples=len(locks['samples']),
            inputs=len(row['events'])+len(row['unpublished_events']),visible=len(row['events']))
    print(json.dumps(dict(artifact_audit='passed',runs=reports),indent=2))
    return reports


if __name__=='__main__':audit()
