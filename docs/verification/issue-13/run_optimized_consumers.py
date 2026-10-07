"""Serial own-PG consumers after the completed performance suite; no overwrite."""
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

from run_optimized_baseline import OUTPUT, PREFIX, PROJECT, command
from run_suite import observe

HERE = Path(__file__).resolve().parent
ROOT = HERE / os.environ.get('ISSUE13_CONSUMER_OUTPUT', 'results/optimized')
SCRIPTS = (
    'optimized_terminal_wait_probe.py',
    'optimized_fairness_probe.py',
    'optimized_consumer_probe.py',
    'optimized_supplemental_probe.py',
    'optimized_high_period_probe.py',
    'optimized_observation_alert_probe.py',
    'optimized_normal_input_probe.py',
    'optimized_network_alert_probe.py',
)


def main():
    source = Path(os.environ.get('ISSUE13_ACCEPTANCE_SOURCE', os.environ.get(
        'ISSUE13_SOURCE', '/home/quant/repos/market-watch-issue13-reviewed-baseline')))
    override=ROOT/'acceptance-source.json'
    if override.exists():
        pinned=json.loads(override.read_text())
        source=Path(pinned['source'])
        actual=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
        if actual!=pinned['commit'] or subprocess.check_output(
                ['git','-C',str(source),'status','--porcelain'],text=True).strip():
            raise SystemExit('Pinned supplementary acceptance source differs or is dirty')
    os.environ['ISSUE13_SOURCE'] = str(source)
    os.environ['ISSUE13_RESULTS'] = str(ROOT)
    state = json.loads((OUTPUT/'state.json').read_text())
    if state['status'] != 'complete':
        raise SystemExit('Performance suite is not complete; no shared database reset')
    running = subprocess.check_output(command(['docker', 'ps', '--filter',
        'label=com.docker.compose.project='+PROJECT, '--format', '{{.Names}}']), text=True).strip()
    if running:
        raise SystemExit('Own other measurement running; never reset its live fixture')
    ROOT.mkdir(exist_ok=True)
    with (ROOT/'consumer-executed-source.json').open('x') as output:
        json.dump(dict(source=str(source), source_commit=subprocess.check_output(
            ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
            scripts={name:hashlib.sha256((source/'docs/verification/issue-13'/name).read_bytes()).hexdigest()
                     for name in SCRIPTS}), output, indent=2)
        output.write('\n')
    # Fixture reset reads its canonical warmup snapshot from /results. Copy only
    # that small immutable initial snapshot into the distinct consumer output.
    with (ROOT/'warmup.json').open('x') as output:
        output.write((OUTPUT/'warmup.json').read_text())
    try:
        subprocess.run(command(PREFIX+['up', '-d', '--wait', 'postgres']), check=True)
        for script in SCRIPTS:
            label = script.removesuffix('.py')
            log = Path('/tmp')/(PROJECT+'-'+label+'.log')
            with log.open('x') as output, (ROOT/(label+'-host.jsonl')).open('x') as samples:
                os.chmod(log, 0o600)
                proc = subprocess.Popen(command(PREFIX+['run', '--rm', '--no-deps',
                    '-v',str(OUTPUT)+':/performance:ro',
                    '--name', PROJECT+'-consumer', 'probe', 'python',
                    'docs/verification/issue-13/'+script]), stdout=output, stderr=subprocess.STDOUT)
                while proc.poll() is None:
                    observe(samples, label)
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
            if proc.returncode:
                raise RuntimeError(f'{label} exit {proc.returncode}; preserve artifacts and inspect private log {log}')
            print(label+' completed', flush=True)
    finally:
        subprocess.run(command(PREFIX+['stop', 'postgres']), check=True)


if __name__ == '__main__':
    main()
