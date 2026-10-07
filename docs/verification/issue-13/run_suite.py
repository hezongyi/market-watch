"""Serial fixed-fixture measurements with Ubuntu host/resource observations.

Starts only this project's capped probe; leaves other projects untouched.
Never retries a failed measurement silently or runs A/B in parallel.
"""
import json
import os
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results'
PREFIX=['docker','compose','--env-file','/tmp/market-watch-issue13-local.env','-p','mw-issue13-p0','-f',str(HERE/'compose.yaml')]


def command(args):
    return ['sg','docker','-c',shlex.join(args)]


def observe(output, label):
    try:
        stats=subprocess.check_output(command(['docker','stats','--no-stream','--format','{{json .}}']),text=True,timeout=30)
        row=dict(at=datetime.now(timezone.utc).isoformat(),label=label,load=os.getloadavg(),
            meminfo=Path('/proc/meminfo').read_text(),vmstat=Path('/proc/vmstat').read_text(),
            proc_stat=Path('/proc/stat').read_text(),
            containers=[json.loads(line) for line in stats.splitlines()],disk_free=os.statvfs(HERE).f_bavail*os.statvfs(HERE).f_frsize)
        output.write(json.dumps(row)+'\n')
        output.flush()
    except Exception as error:
        output.write(json.dumps(dict(at=datetime.now(timezone.utc).isoformat(),label=label,observation_error=type(error).__name__))+'\n')
        output.flush()


def run(args, label, samples):
    proc=subprocess.Popen(command(PREFIX+['run','--rm','--name','mw-issue13-p0-measure','probe','python',
        'docs/verification/issue-13/pg_baseline.py']+args),stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    # Popen handle is the authority; a timeout reading stats does not restart it.
    while proc.poll() is None:
        observe(samples,label)
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired: pass
    content=proc.stdout.read()
    print(content,flush=True)
    (ROOT/(label+'-process.log')).write_text(content)
    if proc.returncode:
        raise SystemExit(f'{label} failed with {proc.returncode}; no automatic restart')


def main():
    if (ROOT/'idle-1.json').exists():
        raise SystemExit('Baseline output exists; archive reviewed results before deliberately rerunning')
    try:
        with (ROOT/'suite-host.jsonl').open('w') as samples:
            for scenario in ('idle','live','backfill','revision'):
                for repetition in range(1,4):
                    label=f'{scenario}-{repetition}'
                    print('START '+label,flush=True)
                    run(['reset'],label+'-reset',samples)
                    run(['measure','--scenario',scenario,'--seconds','300','--repetition',str(repetition)],label,samples)
            print('SUITE COMPLETE',flush=True)
    finally:
        subprocess.run(command(PREFIX+['stop','postgres']),check=True)
        print('Own PostgreSQL stopped; fixture volume retained',flush=True)


if __name__=='__main__': main()
