"""Read-only native-source/CPU observation on the explicitly authorized mw-dev.

Usage: python observe_idle.py OUTPUT.json [SECONDS=300]
Close acceptance browsers and wait for new-source demands to expire first.
No credentials or raw slot tokens are written to the report.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

PROJECT = 'mw-dev'
OUTPUT = Path(sys.argv[1])
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 300
assert DURATION >= 300
SQL = """
from alerts.storage import transaction, SourceSeries, SourceFetch, Preference, ProviderDataset, ProviderInterest, now_ms
from sqlalchemy import select
import json
with transaction() as db:
    native = [s.id for s in db.scalars(select(SourceSeries))
        if s.identity.get('parameters', {}).get('endpoint', '').startswith('native_')]
    snapshots = [{'id':s.id, 'fetched_at':s.fetched_at, 'lease_until':s.lease_until}
        for s in db.scalars(select(SourceFetch).where(SourceFetch.source_id.in_(native)))]
    slot = db.get(Preference, 'upstream_slots:akshare')
    value = slot.value if slot else {}
    datasets = [d.id for d in db.scalars(select(ProviderDataset))
        if d.metadata_json.get('native_operation')]
    interests = [i for i in db.scalars(select(ProviderInterest).where(
        ProviderInterest.dataset_id.in_(datasets), ProviderInterest.expires > now_ms()))]
    print(json.dumps({'at':now_ms(),'snapshots':snapshots,
        'last_akshare_request':max([r['at'] for r in value.get('requests', [])] or [0]),
        'active_akshare_slots':len(value.get('active', [])),
        'active_native_interests':len(interests)}))
"""


def source_state():
    return json.loads(subprocess.check_output(
        ['docker', 'exec', '-i', 'mw-dev-api-1', 'python', '-'], input=SQL, text=True))


def children():
    found = []
    for service in ('api', 'market-runtime', 'data-worker', 'notification-worker'):
        text = subprocess.check_output(['docker', 'top', f'mw-dev-{service}-1',
                                        '-eo', 'pid,args'], text=True)
        found.extend({'service':service, 'pid':line.split()[0]}
                     for line in text.splitlines() if 'alerts.akshare_worker' in line)
    return found


with httpx.Client(transport=httpx.HTTPTransport(uds='/var/run/docker.sock'),
                  base_url='http://docker', timeout=20) as docker:
    containers = docker.get('/containers/json', params={
        'filters':json.dumps({'label':[f'com.docker.compose.project={PROJECT}']})}).json()

    def cpu():
        values = {}
        for container in containers:
            stats = docker.get(f"/containers/{container['Id']}/stats",
                               params={'stream':'false','one-shot':'true'}).json()
            values[container['Names'][0].lstrip('/')] = stats['cpu_stats']['cpu_usage']['total_usage']
        return values

    report = {'project':PROJECT, 'duration_requested':DURATION, 'samples':[],
              'scope':'new native sources; existing development workloads remain active'}
    before = source_state()
    wait_started = time.monotonic()
    while before['active_native_interests'] and time.monotonic() - wait_started < 900:
        OUTPUT.write_text(json.dumps({'phase':'waiting_for_expiry', 'source':before,
                                      'waited_seconds':time.monotonic()-wait_started}, indent=2) + '\n')
        time.sleep(15)
        before = source_state()
    assert before['active_native_interests'] == 0, 'wait for native demands to expire'
    start_cpu, started = cpu(), time.monotonic()
    report['before'] = before
    while True:
        elapsed = time.monotonic() - started
        report['samples'].append({'elapsed':round(elapsed, 3), 'children':children(),
                                  'source':source_state()})
        OUTPUT.write_text(json.dumps(report, indent=2) + '\n')
        if elapsed >= DURATION:
            break
        time.sleep(min(15, DURATION - elapsed))
    end_cpu, ended = cpu(), time.monotonic()
    report['after'] = report['samples'][-1]['source']
    report['seconds'] = ended - started
    report['cpu_single_core_percent'] = {name:round((end_cpu[name]-value)/1e9/
        report['seconds']*100, 4) for name, value in start_cpu.items()}
    report['cpu_four_core_host_percent'] = round(sum(report['cpu_single_core_percent'].values())/4, 4)
    report['akshare_slot_changes'] = sum(s['source']['last_akshare_request'] != before['last_akshare_request']
                                       for s in report['samples'])
    original = {s['id']:s['fetched_at'] for s in before['snapshots']}
    report['native_snapshot_updates'] = sum(original.get(s['id']) != s['fetched_at']
                                          for s in report['after']['snapshots'])
    report['passed'] = (report['native_snapshot_updates'] == report['akshare_slot_changes'] == 0
                        and all(not s['children'] and s['source']['active_native_interests'] == 0
                                for s in report['samples']))
    OUTPUT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('samples','before','after')}))
    raise SystemExit(0 if report['passed'] else 1)
