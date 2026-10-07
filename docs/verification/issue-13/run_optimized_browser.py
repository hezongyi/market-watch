"""Own Ubuntu full-lifespan synthetic browser baseline; bounded services only."""
import hashlib
import json
import os
import subprocess
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

from run_suite import command, observe, HERE
ROOT = HERE / os.environ.get('ISSUE13_CONSUMER_OUTPUT', 'results/optimized')

PROJECT = os.environ.get('ISSUE13_PROJECT', 'mw-issue13-optimized')
PREFIX=['docker','compose','--env-file',os.environ.get('ISSUE13_BROWSER_ENV',
    '/tmp/mw-issue13-optimized-browser-private/compose.env'), '-p',PROJECT,
    '-f',os.environ.get('ISSUE13_COMPOSE',str(HERE/'optimized.compose.yaml')),
    '-f',str(HERE/'optimized_browser.compose.yaml')]
SERVICES=['api','publisher','web','chart-origin']


def main():
    target=ROOT/'browser'
    if target.exists():raise SystemExit('Browser evidence exists; inspect/archive explicitly before rerun')
    running=subprocess.check_output(command(['docker','ps','--filter',
        'label=com.docker.compose.project='+PROJECT,'--format','{{.Names}}']),text=True).strip()
    if running:raise SystemExit('Own other measurement still running; no concurrent fixture reset')
    target.mkdir()
    paths=[HERE/name for name in ('optimized_browser_probe.cjs','browser_setup.py','optimized_browser.compose.yaml',
        'run_optimized_browser.py','capture_optimized_browser_environment.py')]
    (target/'executed-source-manifest.json').write_text(json.dumps({str(p.relative_to(HERE)):
        hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},indent=2)+'\n')
    assets={str(p.relative_to(HERE.parents[2])):hashlib.sha256(p.read_bytes()).hexdigest()
        for directory in ('backend/alerts','web/src','advanced-host')
        for p in (HERE.parents[2]/directory).rglob('*') if p.is_file()
        and '__pycache__' not in p.parts and 'charting_library' not in p.parts}
    (target/'built-source-manifest.json').write_text(json.dumps(assets,indent=2)+'\n')
    try:
        subprocess.run(command(PREFIX+['up','-d','--wait','postgres']),check=True)
        with (target/'setup.log').open('x') as out:
            subprocess.run(command(PREFIX+['run','--rm','probe','python',
                'docs/verification/issue-13/browser_setup.py']),check=True,stdout=out,stderr=subprocess.STDOUT)
        subprocess.run(command(PREFIX+['up','-d']+SERVICES),check=True)
        deadline=time.monotonic()+90
        while True:
            try:
                with urllib.request.urlopen('https://192.168.7.232:19635/readyz',timeout=2,context=ssl._create_unverified_context()) as response:
                    if response.status==200:break
            except (OSError,urllib.error.HTTPError):pass
            if time.monotonic()>deadline:raise SystemExit('Own API readiness timeout; no browser verdict')
            time.sleep(1)
        # Check actual iframe static access too; private credentials remain 0700,
        # but the mounted licensed static directory must be readable by Nginx.
        with urllib.request.urlopen('https://192.168.7.232:19636/',timeout=3,context=ssl._create_unverified_context()) as response:
            if response.status!=200:raise SystemExit('Own chart-origin is unavailable before browser launch')
        with urllib.request.urlopen('https://192.168.7.232:19635/',timeout=3,context=ssl._create_unverified_context()) as response:
            if response.status!=200:raise SystemExit('Own built frontend is unavailable before browser launch')
        with (target/'browser-process.log').open('x') as out,(target/'host.jsonl').open('x') as samples:
            proc=subprocess.Popen(command(PREFIX+['run','--rm','--name',PROJECT+'-browser',
                'browser']),stdout=out,stderr=subprocess.STDOUT)
            while proc.poll() is None:
                observe(samples,'browser')
                if not (target/'services-runtime.json').exists() and proc.poll() is None:
                    subprocess.run(['python3',str(HERE/'capture_optimized_browser_environment.py')],check=True)
                try:proc.wait(timeout=10)
                except subprocess.TimeoutExpired:pass
        if proc.returncode:raise SystemExit(f'Browser exited {proc.returncode}; inspect saved result; no automatic retry')
        print('Optimized browser acceptance completed',flush=True)
    finally:
        # If the orchestrator itself fails or is interrupted, terminate only its
        # own active browser container too; normal --rm completion needs no stop.
        active=subprocess.check_output(command(['docker','ps','--filter',
            'name=^/'+PROJECT+'-browser$','--format','{{.Names}}']),text=True).strip()
        if active:
            subprocess.run(command(['docker','stop',PROJECT+'-browser']),check=True)
        # Specific named task services only. Retain the DB volume and browser
        # failure evidence; no global resource cleanup or other projects touched.
        subprocess.run(command(PREFIX+['stop']+SERVICES+['postgres']),check=True)
        print('Own browser services and PostgreSQL stopped; synthetic volume retained',flush=True)


if __name__=='__main__':main()
