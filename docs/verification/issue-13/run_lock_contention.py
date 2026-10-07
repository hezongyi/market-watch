"""Run one injected PG contention probe, then stop only this project's PG."""
import json
import subprocess

from run_suite import ROOT, PREFIX, command, observe


def main():
    destination = ROOT/'lock-contention'
    if destination.exists():
        raise SystemExit('Lock evidence exists; no overwrite or automatic retry')
    # The persistent services and prior temporary probes must all be stopped
    # before resetting the fixture; names alone are not an idle indication.
    running = subprocess.check_output(command(['docker','ps','--filter',
        'label=com.docker.compose.project=mw-issue13-p0','--format','{{.Names}}']), text=True).strip()
    if running:
        raise SystemExit('Own project has running services; no concurrent fixture reset')
    destination.mkdir()
    proc = None
    try:
        subprocess.run(command(PREFIX+['up','-d','--wait','postgres']), check=True)
        with (destination/'process.log').open('x') as log, (destination/'host.jsonl').open('x') as samples:
            (destination/'process.log').chmod(0o600)
            proc = subprocess.Popen(command(PREFIX+['run','--rm','--name',
                'mw-issue13-p0-lock','probe','python',
                'docs/verification/issue-13/lock_contention_probe.py']), stdout=log, stderr=subprocess.STDOUT)
            while proc.poll() is None:
                observe(samples, 'lock-contention')
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        if proc.returncode:
            raise SystemExit(f'Lock probe exited {proc.returncode}; inspect private log, no retry')
        print('LOCK CONTENTION COMPLETE', flush=True)
    finally:
        if proc is not None and proc.poll() is None:
            subprocess.run(command(['docker','stop','--time','20','mw-issue13-p0-lock']), check=True)
            proc.wait(timeout=30)
        subprocess.run(command(PREFIX+['stop','postgres']), check=True)
        state = json.loads(subprocess.check_output(command(['docker','inspect',
            'mw-issue13-p0-postgres-1','--format','{{json .State}}']), text=True))
        (destination/'postgres-stopped.json').write_text(json.dumps(dict(
            running=state['Running'], exit=state['ExitCode'], oom=state['OOMKilled']), indent=2)+'\n')


if __name__ == '__main__':
    main()
