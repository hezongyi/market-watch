"""Whitelist actual own container runtime evidence, never Docker env secrets."""
import json
import os
import subprocess

from run_suite import command
from pathlib import Path
ROOT = Path(__file__).resolve().parent / os.environ.get('ISSUE13_CONSUMER_OUTPUT','results/optimized')
PROJECT = os.environ.get('ISSUE13_PROJECT','mw-issue13-optimized')

services=['api','publisher','web','chart-origin','postgres']
names=[PROJECT+'-'+s+'-1' for s in services]+[PROJECT+'-browser']
rows=json.loads(subprocess.check_output(command(['docker','inspect']+names),text=True))
output=[]
for c in rows:
    assert c['Config']['Labels'].get('com.docker.compose.project')==PROJECT
    output.append(dict(name=c['Name'].lstrip('/'),image=c['Image'],state={k:c['State'].get(k)
        for k in ['Status','Running','OOMKilled','StartedAt']},networks=list(c['NetworkSettings']['Networks']),
        project=PROJECT,nanocpus=c['HostConfig']['NanoCpus'],memory=c['HostConfig']['Memory'],
        mounts=[{k:m.get(k) for k in ['Type','Source','Destination','RW']} for m in c['Mounts']]))
target=ROOT/'browser'
assert all(c['state']['Running'] for c in output),'Capture during the actual browser run'
assert sum(c['nanocpus'] for c in output if not c['name'].endswith('postgres-1'))<=1_500_000_000
(target/'services-runtime.json').write_text(json.dumps(output,indent=2)+'\n')
network=json.loads(subprocess.check_output(command(['docker','network','inspect',PROJECT+'_offline']),text=True))[0]
assert network['Internal']
api=next(c for c in output if c['name'].endswith('api-1'))
publisher=next(c for c in output if c['name'].endswith('publisher-1'))
assert api['networks']==publisher['networks']==[PROJECT+'_offline']
(target/'network-isolation.json').write_text(json.dumps(dict(name=network['Name'],internal=True,
    members=[x['Name'] for x in network['Containers'].values()]),indent=2)+'\n')
print('Actual live service scope, 1.45CPU application/browser cap and API/publisher internal network verified')
