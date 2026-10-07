"""Serial 750ms-monitor candidate after r5 terminates; independent Ubuntu DB.

Publisher-only r5 measurements are explicitly inherited after byte comparison.
All consumers, full regression, browser and final contracts run on r6 itself.
"""

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
ROOT = HERE / 'results/optimized-r6'
BASELINE = HERE / 'results/optimized-r6-baseline'
SOURCE = Path('/home/quant/repos/market-watch-issue13-r6-acceptance')
COMMIT = 'bcaefcf'
PROJECT = 'mw-issue13-optimized-r6'
PREFIX = ['docker', 'compose', '--env-file', '/tmp/market-watch-issue13-optimized-r6.env',
          '-p', PROJECT, '-f', str(HERE / 'optimized-r6.compose.yaml')]


def docker(args):
    return ['sg', 'docker', '-c', shlex.join(args)]


def mark(stage, **details):
    (ROOT / 'validation-state.json').write_text(json.dumps(dict(
        stage=stage, pid=os.getpid(), source_commit=COMMIT,
        time_utc=time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime()), **details)) + '\n')
    print(stage, flush=True)


def main():
    env = {**os.environ, 'ISSUE13_SOURCE': str(SOURCE), 'ISSUE13_ACCEPTANCE_SOURCE': str(SOURCE),
        'ISSUE13_PROJECT': PROJECT, 'ISSUE13_ENV': '/tmp/market-watch-issue13-optimized-r6.env',
        'ISSUE13_COMPOSE': str(HERE / 'optimized-r6.compose.yaml'),
        'ISSUE13_OUTPUT': 'results/optimized-r6-baseline',
        'ISSUE13_CONSUMER_OUTPUT': 'results/optimized-r6', 'ISSUE13_RESULTS': str(ROOT),
        'ISSUE13_BROWSER_ENV': '/tmp/mw-issue13-optimized-browser-private/compose-r6.env',
        'ISSUE13_BROWSER_COMPOSE': str(SOURCE/'docs/verification/issue-13/optimized_browser.compose.yaml'),
        'ISSUE13_BROWSER_APP_URL': 'https://192.168.7.232:19645',
        'ISSUE13_BROWSER_CHART_URL': 'https://192.168.7.232:19646'}

    def run(args, stage):
        mark(stage)
        log = Path('/tmp') / (PROJECT + '-' + stage + '-driver.log')
        with log.open('x') as output:
            log.chmod(0o600)
            proc = subprocess.Popen(args, cwd=REPO, env=env, stdout=output, stderr=subprocess.STDOUT)
            while proc.poll() is None:
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    pass
        if proc.returncode:
            raise RuntimeError(stage + ' exit ' + str(proc.returncode) + '; private log ' + str(log))
        return log

    try:
        mark('waiting_for_r5_terminal')
        previous = HERE / 'results/optimized-r5'
        while True:
            state = json.loads((previous / 'validation-state.json').read_text())
            if state['stage'] in ('failed', 'validation_complete_manual_assessment_pending'):
                numeric_path = previous / 'numeric-assessment.json'
                numeric = json.loads(numeric_path.read_text()) if numeric_path.exists() else None
                # If r5 unexpectedly passes, finish its existing recovery first.
                if numeric and numeric['all_assessed_gates_passed'] and not numeric['missing']:
                    mark('not_started_r5_passed_finish_original_candidate')
                    return
                active = subprocess.check_output(docker(['docker', 'ps', '--filter',
                    'label=com.docker.compose.project=mw-issue13-optimized-r5', '--format', '{{.Names}}']), text=True).strip()
                if not active:
                    break
            try:
                os.kill(state['pid'], 0)
            except ProcessLookupError:
                if state['stage'] not in ('failed', 'validation_complete_manual_assessment_pending'):
                    mark('not_started_prior_handle_missing')
                    return
            time.sleep(15)
        actual = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
        assert actual.startswith(COMMIT)
        assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
        manifest = json.loads((previous / 'product-source-manifest.json').read_text())
        changes = []
        product = {}
        for name, digest in manifest['product_files'].items():
            value = hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()
            product[name] = value
            if value != digest:
                changes.append(name)
        assert changes == ['backend/alerts/alert_monitor.py'], changes
        (ROOT / 'product-source-manifest.json').write_text(json.dumps(dict(
            source=str(SOURCE), commit=actual, product_files=product,
            changed_from_r5=changes, scope='Only monitor default cadence differs; publisher/migrations byte-equal'), indent=2) + '\n')
        # The r5 12x300s suite never runs the monitor. Retain its true original
        # source/host/state provenance, rather than relabeling it as an r6 run.
        assert not BASELINE.exists()
        shutil.copytree(HERE / 'results/optimized-r5-baseline', BASELINE)
        inherited = dict(original_source_commit=manifest['commit'], candidate_commit=actual,
            changed_product_files=changes, unchanged_publisher_and_migrations=True,
            original_results='results/optimized-r5-baseline',
            scope='Inherited publisher-only measurements; monitor absent from that workload. Full r6 consumer/concurrency and regression measured anew.',
            files={p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in BASELINE.iterdir() if p.is_file()})
        (ROOT / 'inherited-publisher-evidence.json').write_text(json.dumps(inherited, indent=2) + '\n')
        # Prepare an owned frontend for the distinct chart port, serially after
        # all r5 measurement services have stopped. No product frontend changes.
        run(docker(['mw-docker', 'build', '--repo', str(SOURCE), '--component', 'web',
            '--tag', 'market-watch-web:issue13-r6', '--task', PROJECT, '--project', PROJECT,
            '--purpose', 'acceptance', '--build-arg',
            'VITE_ADVANCED_CHART_ORIGIN=https://192.168.7.232:19646']), 'web_build')
        web_image = subprocess.check_output(docker(['docker', 'image', 'inspect',
            'market-watch-web:issue13-r6', '--format', '{{.Id}}']), text=True).strip()
        browser_env = Path(env['ISSUE13_BROWSER_ENV'])
        lines = browser_env.read_text().splitlines()
        assert any(line.startswith('ISSUE13_WEB_IMAGE=') for line in lines)
        browser_env.write_text('\n'.join('ISSUE13_WEB_IMAGE=' + web_image
            if line.startswith('ISSUE13_WEB_IMAGE=') else line for line in lines) + '\n')
        browser_env.chmod(0o600)
        run(docker(PREFIX + ['up', '-d', '--wait', 'postgres']), 'postgres_start')
        log = run(['python3', '/tmp/mw-issue13-test.py', 'r6-backend-frozen', '-q', 'backend/tests'], 'full_regression')
        # Counts are parsed from the actual completed pytest output, never guessed.
        import re
        summary = re.search(r'(\d+) passed, (\d+) skipped, (\d+) warnings in ([\d.]+)s', log.read_text())
        assert summary
        (ROOT / 'full-regression-result.json').write_text(json.dumps(dict(source_commit=actual,
            passed=int(summary[1]), skipped=int(summary[2]), warnings=int(summary[3]), seconds=float(summary[4]),
            exit_code=0, private_log_sha256=hashlib.sha256(log.read_bytes()).hexdigest(),
            complete_acceptance=False, environment='Ubuntu own mw-issue13-optimized-r6 PG 127.0.0.1:19703'), indent=2) + '\n')
        # Seed this candidate's own database. Existing r5 evidence stays immutable;
        # fixture/warmup provenance for r6 is saved separately, not overwritten.
        fixture = ROOT / 'fixture-setup'
        fixture.mkdir()
        original_results = env['ISSUE13_RESULTS']
        env['ISSUE13_RESULTS'] = str(fixture)
        try:
            for action in ('setup', 'warmup'):
                run(docker(PREFIX + ['run', '--rm', '--no-deps', 'probe', 'python',
                    'docs/verification/issue-13/pg_baseline.py', action]), 'fixture_' + action)
        finally:
            env['ISSUE13_RESULTS'] = original_results
        assert json.loads((fixture / 'warmup.json').read_text()) == json.loads((BASELINE / 'warmup.json').read_text())
        run(docker(PREFIX + ['stop', 'postgres']), 'fixture_postgres_stop')
        run(['python3', '-u', str(HERE / 'run_optimized_consumers.py')], 'consumers')
        # Browser runner's orchestration URLs are part of the r6 frozen probe.
        run(['python3', '-u', str(HERE / 'run_optimized_browser.py')], 'browser')
        run(['python3', str(HERE / 'audit_optimized_consumers.py')], 'consumer_audit')
        run(['python3', str(HERE / 'assess_optimized_acceptance.py')], 'numeric_assessment')
        numeric = json.loads((ROOT / 'numeric-assessment.json').read_text())
        if not numeric['all_assessed_gates_passed'] or numeric['missing']:
            mark('numeric_failed', failed=[r['name'] for r in numeric['results'] if not r['passed']], missing=numeric['missing'])
            return
        run(docker(PREFIX + ['up', '-d', '--wait', 'postgres']), 'recovery_postgres_start')
        try:
            run(docker(PREFIX + ['run', '--rm', '--no-deps', 'probe', 'python',
                'docs/verification/issue-13/verify_publication_crash.py']), 'publication_crash')
            run(docker(PREFIX + ['run', '--rm', '--no-deps', '-v',
                '/home/quant/repos/market-watch-issue13-v114-baseline:/oldsource:ro', 'probe', 'python',
                'docs/verification/issue-13/verify_application_rollback.py']), 'application_rollback')
            for name in ('verify_publication_postcommit.py', 'verify_rotation_faults.py'):
                run(docker(PREFIX + ['run', '--rm', '--no-deps', '-e', 'ISSUE13_PRODUCT_COMMIT=' + actual,
                    '-v', str(HERE / name) + ':/extra_probe.py:ro', 'probe', 'python', '/extra_probe.py']), name.removesuffix('.py'))
            run(docker(PREFIX + ['run', '--rm', '--no-deps', 'probe', 'python',
                'docs/verification/issue-13/verify_coverage_projection.py']), 'coverage_replay')
        finally:
            subprocess.run(docker(PREFIX + ['stop', 'postgres']), cwd=REPO, env=env, check=True)
        mark('validation_complete_manual_assessment_pending')
    except Exception as error:
        mark('failed', error=str(error))
        subprocess.run(docker(PREFIX + ['stop', 'postgres']), cwd=REPO, env=env, check=True)
        raise


if __name__ == '__main__':
    main()
