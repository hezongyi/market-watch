"""Read-only API thread CPU and aggregate access counts; no env/raw log persistence."""
import json
import os
import re
import shlex
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE=Path(__file__).resolve().parent


def docker(*args):
    return subprocess.check_output(['sg','docker','-c',shlex.join(['docker',*args])],
        text=True,timeout=30,stderr=subprocess.STDOUT)


def thread_sample(pid):
    rows={}
    for task in (Path('/proc')/str(pid)/'task').iterdir():
        try:
            stat=(task/'stat').read_text()
            # stat comm may contain spaces; remaining fields begin at state (field3).
            fields=stat[stat.rfind(')')+2:].split()
            rows[int(task.name)]=dict(comm=(task/'comm').read_text().strip(),state=fields[0],
                cpu_ticks=int(fields[11])+int(fields[12]))
        except (FileNotFoundError,ProcessLookupError,PermissionError):
            continue
    return rows


def main():
    names=docker('ps','--filter','name=-api-1','--format','{{.Names}}').splitlines()
    targets=[]
    for name in names:
        # State.Pid identifies persistent API init; docker top can also include
        # transient Python health checks and duplicate a container in the sample.
        pid=int(docker('inspect',name,'--format','{{.State.Pid}}').strip())
        comm=(Path('/proc')/str(pid)/'comm').read_text().strip()
        if 'python' in comm or comm=='uvicorn':
            targets.append((name,pid))
    ticks=os.sysconf('SC_CLK_TCK')
    samples=[]
    for _ in range(3):
        before={}
        errors=[]
        for name,pid in targets:
            try: before[name]=(time.monotonic(),thread_sample(pid))
            except (FileNotFoundError,PermissionError) as error: errors.append(dict(container=name,error=type(error).__name__))
        time.sleep(5)
        sample=dict(at=datetime.now(timezone.utc).isoformat(),errors=errors,containers=[])
        for name,pid in targets:
            if name not in before: continue
            try:
                after=thread_sample(pid)
                elapsed=time.monotonic()-before[name][0]
                rows=[]
                for tid,row in after.items():
                    old=before[name][1].get(tid)
                    if old:
                        rows.append(dict(tid=tid,comm=row['comm'],state=row['state'],
                            is_main=tid==pid,cpu_percent=100*(row['cpu_ticks']-old['cpu_ticks'])/ticks/elapsed))
                sample['containers'].append(dict(name=name,host_pid=pid,seconds=elapsed,threads=rows,
                    cpu_percent=sum(r['cpu_percent'] for r in rows)))
            except (FileNotFoundError,PermissionError) as error:
                sample['errors'].append(dict(container=name,error=type(error).__name__))
        samples.append(sample)
    traffic=[]
    for name,_ in targets:
        counts=Counter()
        health=0
        try:
            # Query strings and paths are discarded. Persist only health/nonhealth totals.
            logs=docker('logs','--since','60s',name)
            for line in logs.splitlines():
                match=re.search(r'"(GET|POST|PATCH|DELETE|PUT|HEAD|OPTIONS) (\S+) HTTP/[^\"]+" (\d{3})',line)
                if match:
                    verb,path,status=match.groups()
                    counts[verb+' '+status]+=1
                    health+=int(path.split('?')[0] in ('/health','/api/health','/healthz','/readyz'))
            traffic.append(dict(name=name,window_seconds=60,access_requests=sum(counts.values()),health_requests=health,
                by_method_status=dict(counts),note='Access logs only; disabled access logging/SSE/messages not observable'))
        except subprocess.CalledProcessError:
            traffic.append(dict(name=name,error='Docker logs unavailable'))
    (HERE/'api-observation.json').write_text(json.dumps(dict(at=datetime.now(timezone.utc).isoformat(),
        samples=samples,traffic=traffic,scope='Existing Ubuntu APIs read-only; no stack attribution, DB access, or configuration changes'),indent=2)+'\n')
    print(f'{len(targets)} API processes observed in three 5-second samples; no resources changed')


if __name__=='__main__': main()
