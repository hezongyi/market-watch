"""Optimized candidate measurements with a frozen source and independent database."""
import hashlib
import json
import os
import shlex
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get('ISSUE13_SOURCE', '/home/quant/repos/market-watch-issue13-optimized-baseline'))
OUTPUT = HERE / os.environ.get('ISSUE13_OUTPUT', 'results/optimized-baseline')
ENV = Path(os.environ.get('ISSUE13_ENV', '/tmp/market-watch-issue13-optimized.env'))
PROJECT = os.environ.get('ISSUE13_PROJECT', 'mw-issue13-optimized')
COMPOSE = Path(os.environ.get('ISSUE13_COMPOSE', str(HERE / 'optimized.compose.yaml')))
PREFIX = ['docker', 'compose', '--env-file', str(ENV), '-p', PROJECT, '-f', str(COMPOSE)]


def command(args):
    return ['sg', 'docker', '-c', shlex.join(args)]


def run(args, label):
    # Exceptions may contain DB parameters: raw process output stays private.
    log = Path('/tmp') / (PROJECT + '-' + label + '.log')
    with log.open('x') as output:
        os.chmod(log, 0o600)
        process = subprocess.Popen(command(PREFIX + args), stdout=output, stderr=subprocess.STDOUT)
        while process.poll() is None:
            from run_suite import observe
            with (OUTPUT / 'host.jsonl').open('a') as samples:
                observe(samples, label)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
    if process.returncode:
        raise RuntimeError(f'{label}: exit {process.returncode}; inspect private log {log}')
    print(label + ' complete', flush=True)


def main():
    if OUTPUT.exists():
        raise SystemExit('Output already exists; review terminal/live state, never restart automatically')
    if subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip():
        raise SystemExit('Frozen source worktree is dirty')
    OUTPUT.mkdir()
    os.environ['ISSUE13_SOURCE'] = str(SOURCE)
    os.environ['ISSUE13_RESULTS'] = str(OUTPUT)
    commit = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    (OUTPUT / 'source.json').write_text(json.dumps(dict(
        started_at=datetime.now(timezone.utc).isoformat(), commit=commit,
        project=PROJECT, source=str(SOURCE), pid=os.getpid(),
        executed_runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        executed_compose_sha256=hashlib.sha256(COMPOSE.read_bytes()).hexdigest(),
        files={str(p.relative_to(SOURCE)): hashlib.sha256(p.read_bytes()).hexdigest()
               for p in sorted((SOURCE / 'backend/alerts').rglob('*.py'))}), indent=2) + '\n')
    state = OUTPUT / 'state.json'
    try:
        run(['up', '-d', '--wait', 'postgres'], 'start')
        # Validate the existing dependency image rather than installing in shared venv.
        run(['run', '--rm', '--no-deps', '--name', PROJECT+'-dependencies', 'probe', 'python', '-c',
             'import pytest, yfinance, dukascopy_python, alembic, psycopg; print("dependencies available")'], 'dependencies')
        for action in ('setup', 'warmup'):
            run(['run', '--rm', '--no-deps', '--name', PROJECT+'-prepare', 'probe', 'python',
                 'docs/verification/issue-13/pg_baseline.py', action], action)
        # Scenario-first pass gives all four scenes before additional repetitions.
        for repetition in range(1, 4):
            for scenario in ('idle', 'live', 'backfill', 'revision'):
                label = f'{scenario}-{repetition}'
                state.write_text(json.dumps(dict(status='running', current=label, pid=os.getpid())) + '\n')
                run(['run', '--rm', '--no-deps', '--name', PROJECT+'-measure', 'probe', 'python',
                     'docs/verification/issue-13/pg_baseline.py', 'reset'], label + '-reset')
                run(['run', '--rm', '--no-deps', '--name', PROJECT+'-measure', 'probe', 'python',
                     'docs/verification/issue-13/pg_baseline.py', 'measure', '--scenario', scenario,
                     '--seconds', '300', '--repetition', str(repetition)], label)
        state.write_text(json.dumps(dict(status='complete', commit=commit, runs=12)) + '\n')
        print('SUITE COMPLETE', flush=True)
    except Exception as error:
        state.write_text(json.dumps(dict(status='failed', error=str(error))) + '\n')
        raise
    finally:
        subprocess.run(command(PREFIX + ['stop', 'postgres']), check=True)


if __name__ == '__main__':
    main()
