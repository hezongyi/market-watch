"""Read retained run completion markers after timing; never mutate app state."""
import json
from pathlib import Path
import re
import subprocess
import time

TASK = Path('/tmp/mw-issue74-20261017')
OUTPUT = TASK/'history-completion-v2b.json'
assert not OUTPUT.exists(), 'retain earlier audit'
records = [(p.name,json.loads(p.read_text())) for p in sorted(TASK.glob('latency-execution-v2b*.json'))]
ids = set()


def run_ids(value):
    found = set()
    if isinstance(value,dict):
        ident = value.get('run_id')
        if isinstance(ident,str) and re.fullmatch('[a-f0-9]{64}',ident):
            found.add(ident)
        for child in value.values():
            found.update(run_ids(child))
    elif isinstance(value,list):
        for child in value:
            found.update(run_ids(child))
    return found


for _,record in records:
    ids.update(run_ids(record))
assert ids
quoted = ','.join("'"+ident+"'" for ident in sorted(ids))
sql = f'''SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (
SELECT id,status,cursor,target_end,updated_at,input_revision,history_version_id,revision_id
FROM market_fixed_indicator_runs WHERE id IN ({quoted}) ORDER BY id) x;'''
proc = subprocess.run(['docker','exec','-i','mw-issue74-20261017-pg-1','sh','-c',
    'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    input=sql,text=True,capture_output=True,check=True)
observed_at = int(time.time()*1000)
runs = {row['id']:row for row in json.loads(proc.stdout)}
groups = []
for filename,record in records:
    samples = []
    for sample in record.get('samples',[]):
        started = sample.get('at')
        if started is None and sample.get('covered') and sample.get('coverageMs') is not None:
            started = record['environment']['timeOrigin'] + sample['covered']['at'] - sample['coverageMs']
        timings=[]
        for ident in sorted(run_ids(sample)):
            run = runs.get(ident)
            complete = run and run['status']=='complete'
            receipts=[]
            for response in sample.get('requests',[]) + sample.get('warmupRequests',[]):
                if any(item.get('calculation',{}).get('run_id')==ident and
                       item['calculation'].get('status')=='complete' for item in response.get('indicators',[]) or []):
                    receipts.append(response['at'])
            upper = min(receipts+[observed_at])
            timings.append({'run_id':ident,'observed_status':run['status'] if run else 'missing',
                'backend_completion_marker_ms':run['updated_at'] if complete else None,
                'completion_observed_by_ms':upper if complete else None,
                'already_complete_before_operation':bool(complete and started is not None and run['updated_at']<=started),
                'T_history_complete_lower_ms':max(0,run['updated_at']-started) if complete and started is not None else None,
                'T_history_complete_upper_ms':max(0,upper-started) if complete and started is not None else None})
        samples.append({'index':sample['index'],'operation_at_ms':started,'runs':timings,
            'timing_reason':None if started is not None else 'failed sample did not retain an operation-start timestamp'})
    groups.append({'file':filename,'phase':record.get('config',{}).get('phase'),'samples':samples})
evidence={'observedAt':observed_at,'candidate':'21c386e','source':'retained browser receipts plus read-only task PostgreSQL run metadata',
    'meaning':'updated_at of an immutable complete run is the worker completion marker before its transaction commit; the first complete HTTP receipt or this database read bounds publication above; these bounds are separate from native first/coverage latency',
    'limits':['no durable input-acceptance timestamp is inferred','provider/managed synchronous-prefix calculations have no fixed-history run timing here',
              'a failed sample without a retained operation-start timestamp remains unmeasured'],
    'runs':list(runs.values()),'groups':groups}
OUTPUT.write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({'output':str(OUTPUT),'observedRuns':len(runs),'completeRuns':sum(r['status']=='complete' for r in runs.values()),'groups':len(groups)}))
