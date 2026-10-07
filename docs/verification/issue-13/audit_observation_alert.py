"""Audit every marker and the stale/recovery timeline without live database I/O."""
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results/observation-alert'


def stable(payload):
    return {key:value for key,value in payload.items() if key!='observed_at'}


def quantiles(values):
    ordered=sorted(values)
    return {name:ordered[math.ceil(len(ordered)*q)-1] if ordered else None
        for name,q in [('p50',.5),('p95',.95),('p99',.99)]}


def main():
    result=json.loads((ROOT/'result.json').read_text())
    timeline=[json.loads(line) for line in (ROOT/'timeline.jsonl').read_text().splitlines()]
    assert result['outcome']=='passed' and not result['errors']
    assert result['duration']>=330 and result['seconds_requested']==330
    assert result['inputs']==len(result['events'])==50 and result['identity_count']==10
    assert len(timeline)==result['sample_count'] and len(timeline)>300
    ids=sorted(result['before'])
    assert len(ids)==10
    for previous,current in zip(timeline,timeline[1:]):
        assert previous['observed_seconds']<=current['query_start_seconds']<=current['observed_seconds']
        assert previous['consumer_clock']<=current['consumer_clock']
    for sample in timeline:
        assert sorted(sample['identities'])==ids
        for state in sample['identities'].values():
            assert state['count']==0 and state['status']=='active'
            assert state['health'] in ('ready','stale')
            assert state['sequence']<=sample['consumer_clock']
            assert state['published_observed_at']<=sample['consumer_clock']
    counter=Counter((item['instrument'],item['batch']) for item in result['events'])
    assert counter==Counter({(ident,batch):1 for ident in ids for batch in range(5)})
    exact_visible=exact_judged=0
    for item in result['events']:
        ident,marker=item['instrument'],item['source_observed_at']
        assert item['scheduled_seconds']==result['schedule_seconds'][item['batch']]
        assert item['committed_seconds']>=item['commit_window_begin_seconds']>=item['scheduled_seconds']
        first_visible=next((sample for sample in timeline if
            sample['identities'][ident]['published_observed_at']==marker),None)
        first_judged=next((sample for sample in timeline if sample['identities'][ident]['sequence']==marker),None)
        assert item['visible_seconds']==(first_visible['observed_seconds'] if first_visible else None)
        assert item['judged_seconds']==(first_judged['observed_seconds'] if first_judged else None)
        if first_visible:
            exact_visible+=1
            assert first_visible['observed_seconds']>=item['commit_window_begin_seconds']
            assert item['commit_to_visible']==first_visible['observed_seconds']-item['committed_seconds']
        if first_judged:
            exact_judged+=1
            assert first_judged['observed_seconds']>=item['commit_window_begin_seconds']
            assert item['judgment_health']=='ready'
        if first_judged and first_visible:
            assert item['visible_to_judged']==first_judged['observed_seconds']-first_visible['observed_seconds']
    assert (exact_visible,exact_judged)==(result['visible'],result['judged'])
    lifecycle=[]
    for ident in ids:
        before,final=result['before'][ident],result['final'][ident]
        assert stable(before['payload'])==stable(final['published_payload'])
        assert before['source_price_revision']==final['source_price_revision']
        assert before['source_volume_revision']==final['source_volume_revision']
        latest=max(item['source_observed_at'] for item in result['events'] if item['instrument']==ident)
        assert final['source_observed_at']==final['published_payload']['observed_at']==final['sequence']==latest
        assert final['health']=='ready' and final['status']=='active'
        assert final['count']==final['signal_count']==0
        samples=[(sample,sample['identities'][ident]) for sample in timeline]
        stale=next(sample for sample,state in samples if sample['observed_seconds']<235 and state['health']=='stale')
        assert stale['consumer_clock']-stale['identities'][ident]['published_observed_at']>120000
        last_before_pause=max(item['source_observed_at'] for item in result['events']
            if item['instrument']==ident and item['batch']<=2)
        recovered=next(sample for sample,state in samples if sample['observed_seconds']>=235
            and state['health']=='ready' and state['sequence']>last_before_pause)
        assert result['freshness'][ident]['first_stale_seconds']==stale['observed_seconds']
        assert result['freshness'][ident]['first_recovered_seconds']==recovered['observed_seconds']
        lifecycle.append(dict(instrument=ident,first_stale=stale['observed_seconds'],
            age_at_stale_seconds=(stale['consumer_clock']-stale['identities'][ident]['published_observed_at'])/1000,
            first_recovered=recovered['observed_seconds'],latest_marker_confirmed=True))
    assert result['queries'].get('alert_staging_reads',0)==result['queries'].get('alert_audit_reads',0)==0
    for name,sha in result['source_sha256'].items():
        relative=name.removeprefix('/workspace/')
        assert hashlib.sha256((HERE.parents[2]/relative).read_bytes()).hexdigest()==sha,name
    assert json.loads((ROOT/'postgres-stopped.json').read_text())==dict(running=False,exit=0,oom=False)
    audit=dict(passed=True,input_denominator=50,exact_visible=exact_visible,exact_judged=exact_judged,
        missing_exact_visible=50-exact_visible,missing_exact_judged=50-exact_judged,
        lifecycle=lifecycle,timeline_samples=len(timeline),
        negative_observed_judgment_delays=sum(item['visible_to_judged']<0 for item in result['events'] if item['visible_to_judged'] is not None),
        commit_to_visible=quantiles([item['commit_to_visible'] for item in result['events'] if item['commit_to_visible'] is not None]),
        visible_to_judged=quantiles([item['visible_to_judged'] for item in result['events'] if item['visible_to_judged'] is not None]),
        scope='Full 330s timeline, all 50 exact markers, ten stale/recovery lifecycles, latest-marker propagation',
        limitations=['Sequential read-committed samples cannot prove exact commit-to-commit ordering or SLA',
            'No price crossing events; zero signal counts prove no spurious trigger in this fixed condition only'])
    (ROOT/'artifact-audit.json').write_text(json.dumps(audit,indent=2)+'\n')
    print(f'Observation audit passed: {exact_visible}/50 exact published, {exact_judged}/50 exact judged; ten stale/recovery paths')


if __name__=='__main__':
    main()
