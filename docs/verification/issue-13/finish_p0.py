"""Continue an already-live suite: audit, summarize, consumer probe, own PG stop.

Observe the specific Linux PID/start time; never restart the suite from a log or
an observation timeout. After it exits, require all actual terminal evidence.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
ROOT=HERE/'results'
COMPOSE=['docker','compose','--env-file','/tmp/market-watch-issue13-local.env','-p','mw-issue13-p0','-f',str(HERE/'compose.yaml')]


def identity(pid):
    path=Path('/proc')/str(pid)
    try:
        stat=(path/'stat').read_text()
        fields=stat[stat.rfind(')')+2:].split()
        return dict(start_ticks=fields[19],state=fields[0],command=(path/'cmdline').read_bytes().replace(b'\0',b' ').decode())
    except FileNotFoundError:
        return None


def docker(args):
    return ['sg','docker','-c',shlex.join(COMPOSE+args)]


def run(name,args):
    # Private logs: an unexpected DB exception might include auth parameters.
    private=Path('/tmp')/('mw-issue13-p0-'+name+'.log')
    fd=os.open(private,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as output:
        result=subprocess.run(args,cwd=REPO,stdout=output,stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f'{name} failed with exit {result.returncode}; private log {private}')
    print(name+' complete',flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--suite-pid',type=int,required=True)
    args=parser.parse_args()
    source=identity(args.suite_pid)
    if not source or 'docs/verification/issue-13/run_suite.py' not in source['command'] or source['state']=='Z':
        raise SystemExit('Specified suite process is not currently live; inspect terminal state manually')
    state=ROOT/'finish-state.json'
    if state.exists():
        raise SystemExit('Finisher state already exists; inspect it and do not launch a duplicate continuation')
    state.write_text(json.dumps(dict(status='waiting_live_suite',suite_pid=args.suite_pid,start_ticks=source['start_ticks']))+'\n')
    print('Observed live suite; waiting on PID/start ticks '+str(args.suite_pid),flush=True)
    while True:
        current=identity(args.suite_pid)
        if not current or current['start_ticks']!=source['start_ticks'] or current['state']=='Z':break
        time.sleep(10)
    try:
        run('audit',[sys.executable,str(HERE/'audit_measurements.py'),'--complete'])
        run('summary',[sys.executable,str(HERE/'summarize.py')])
        run('consumer-start',docker(['up','-d','--wait','postgres']))
        try:
            run('consumer',docker(['run','--rm','--name','mw-issue13-p0-consumer','probe','python',
                'docs/verification/issue-13/consumer_probe.py']))
        finally:
            run('consumer-stop',docker(['stop','postgres']))
        state.write_text(json.dumps(dict(status='complete',scope='Four-scene artifact audit/report + consumer microbaseline; core issue still waits three-layer merge'))+'\n')
        print('P0 report and consumer microbaseline complete; own PG stopped',flush=True)
    except Exception as error:
        state.write_text(json.dumps(dict(status='failed',error=str(error)))+'\n')
        print(str(error),flush=True)
        raise SystemExit(1)


if __name__=='__main__':main()
