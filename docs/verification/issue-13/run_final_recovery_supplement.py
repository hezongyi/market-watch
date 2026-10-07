"""Serial final-contract probes after the existing r5 recovery run stops.

Never restart or reset the primary measurement. Failed or missing prior evidence
ends this follow-up without starting PostgreSQL. Private Compose env is required.
"""

import hashlib
import json
import os
import shlex
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
ROOT = HERE / 'results/optimized-r5'
OUTPUT = ROOT / 'final-contracts'
SOURCE = Path('/home/quant/repos/market-watch-issue13-r5-acceptance')
COMMIT = 'ccb2a12b47ea1c9fd06517c2ccf3dec670532ee4'
PROJECT = 'mw-issue13-optimized-r5'
PREFIX = ['docker', 'compose', '--env-file', '/tmp/market-watch-issue13-optimized-r5.env',
          '-p', PROJECT, '-f', str(HERE / 'optimized-r5.compose.yaml')]


def docker(args):
    return ['sg', 'docker', '-c', shlex.join(args)]


def mark(stage, **details):
    (ROOT / 'final-contract-state.json').write_text(json.dumps(dict(
        stage=stage, pid=os.getpid(), source_commit=COMMIT,
        time_utc=time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime()), **details)) + '\n')
    print(stage, flush=True)


def main():
    probe = HERE / 'verify_publication_postcommit.py'
    expected_probe = hashlib.sha256(probe.read_bytes()).hexdigest()
    env = {**os.environ, 'ISSUE13_SOURCE': str(SOURCE), 'ISSUE13_RESULTS': str(OUTPUT)}

    def run(args, label):
        mark(label)
        log = Path('/tmp') / (PROJECT + '-final-contract-' + label + '.log')
        with log.open('x') as output:
            log.chmod(0o600)
            proc = subprocess.Popen(docker(args), cwd=REPO, env=env,
                                    stdout=output, stderr=subprocess.STDOUT)
            while proc.poll() is None:
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    pass
        if proc.returncode:
            raise RuntimeError(label + ' exit ' + str(proc.returncode) + '; private log ' + str(log))

    try:
        mark('waiting_for_primary_and_recovery')
        while True:
            recovery = json.loads((ROOT / 'recovery-state.json').read_text())
            if recovery['stage'] == 'recovery_complete_manual_assessment_pending':
                break
            if recovery['stage'] == 'failed' or recovery['stage'].startswith('not_started'):
                mark('not_started_prior_recovery_failed_or_incomplete')
                return
            try:
                os.kill(recovery['pid'], 0)
            except ProcessLookupError:
                mark('not_started_prior_recovery_handle_missing')
                return
            time.sleep(15)
        primary = json.loads((ROOT / 'validation-state.json').read_text())
        numeric = json.loads((ROOT / 'numeric-assessment.json').read_text())
        assert primary['stage'] == 'validation_complete_manual_assessment_pending'
        assert numeric['all_assessed_gates_passed'] and not numeric['missing']
        assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == COMMIT
        assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
        manifest = json.loads((ROOT / 'product-source-manifest.json').read_text())
        assert manifest['commit'] == COMMIT
        for name, expected in manifest['product_files'].items():
            assert hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() == expected, name
        assert hashlib.sha256(probe.read_bytes()).hexdigest() == expected_probe, 'Supplementary probe changed while waiting'
        active = subprocess.check_output(docker(['docker', 'ps', '--filter',
            'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Names}}']), text=True).strip()
        assert not active, 'Owned services still running; no concurrent contract tests'
        assert not OUTPUT.exists(), 'Never overwrite earlier evidence'
        OUTPUT.mkdir()
        coverage = SOURCE / 'docs/verification/issue-13/verify_coverage_projection.py'
        executed = dict(source=str(SOURCE), product_commit=COMMIT,
            product_manifest_sha256=hashlib.sha256((ROOT / 'product-source-manifest.json').read_bytes()).hexdigest(),
            postcommit_probe_sha256=expected_probe,
            coverage_probe_sha256=hashlib.sha256(coverage.read_bytes()).hexdigest(),
            runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            scope='Separate read-only mounted probe executes immutable product after all primary/recovery services stop')
        (OUTPUT / 'executed-source.json').write_text(json.dumps(executed, indent=2) + '\n')
        run(PREFIX + ['up', '-d', '--wait', 'postgres'], 'postgres_start')
        try:
            run(PREFIX + ['run', '--rm', '--no-deps', '-e', 'ISSUE13_PRODUCT_COMMIT=' + COMMIT,
                '-v', str(probe) + ':/postcommit_probe.py:ro', 'probe', 'python',
                '/postcommit_probe.py'], 'publication_postcommit')
            run(PREFIX + ['run', '--rm', '--no-deps', 'probe', 'python',
                'docs/verification/issue-13/verify_coverage_projection.py'], 'coverage_replay')
        finally:
            subprocess.run(docker(PREFIX + ['stop', 'postgres']), cwd=REPO, env=env, check=True)
        mark('final_contracts_complete_manual_assessment_pending')
    except Exception as error:
        mark('failed', error=str(error))
        raise


if __name__ == '__main__':
    main()
