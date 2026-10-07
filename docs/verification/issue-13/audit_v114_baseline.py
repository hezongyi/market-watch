"""Audit integrated-source artifacts without altering the original P0 outputs."""
import argparse
import json
import statistics
import subprocess
from pathlib import Path

import audit_measurements
from run_v114_baseline import OUTPUT, PREFIX, command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--complete', action='store_true')
    args = parser.parse_args()
    audit_measurements.ROOT = OUTPUT
    completed, missing, metrics = [], [], []
    for scenario in audit_measurements.SCENARIOS:
        for repetition in range(1, 4):
            name = f'{scenario}-{repetition}'
            path = OUTPUT / (name + '.json')
            if not path.exists():
                missing.append(name)
                continue
            completed.append(audit_measurements.audit(scenario, repetition))
            result = json.loads(path.read_text())
            metrics.append(dict(run=name, scenario=scenario, duration=result['duration'],
                cpu_percent=result['process_cpu_percent'],
                sql_per_second=result['queries']['total'] / result['duration'],
                audit_reads_per_second=result['queries'].get('audit_reads', 0) / result['duration'],
                latency_p95=result['latency_p95'], latency_p99=result['latency_p99'],
                longest_target_wait=result['longest_target_wait'],
                backfill_bars_per_second=result['backfill_bars_per_second']))
    state = json.loads((OUTPUT / 'state.json').read_text())
    terminal = state['status'] == 'complete'
    if args.complete:
        assert not missing, 'Incomplete runs: ' + ','.join(missing)
        assert terminal, 'Suite runner has not recorded successful completion'
        ident = subprocess.check_output(command(PREFIX + ['ps', '-a', '-q', 'postgres']), text=True).strip()
        assert ident, 'Own PG container is missing; inspect lifecycle evidence'
        result = json.loads(subprocess.check_output(command([
            'docker', 'inspect', '--format', '{{json .State}}', ident]), text=True))
        assert not result['Running'] and not result['OOMKilled'] and result['ExitCode'] == 0, result
    # Partial audit is evidence of completed samples only, never a full verdict.
    print(json.dumps(dict(audited=len(completed), required=12, missing=missing,
                         terminal=terminal, measurements=metrics), indent=2))
    if args.complete:
        groups = {scenario: dict(
            cpu_percent=statistics.mean(r['cpu_percent'] for r in metrics if r['scenario'] == scenario),
            sql_per_second=statistics.mean(r['sql_per_second'] for r in metrics if r['scenario'] == scenario),
            audit_reads_per_second=statistics.mean(r['audit_reads_per_second'] for r in metrics if r['scenario'] == scenario),
            max_target_wait=max(r['longest_target_wait'] for r in metrics if r['scenario'] == scenario))
            for scenario in audit_measurements.SCENARIOS}
        report = dict(complete=True, runs=completed, metrics=metrics, summary=groups,
                      scope='Artifact consistency; no complete payload/correctness or performance pass implied')
        with (OUTPUT / 'measurement-audit.json').open('x') as file:
            json.dump(report, file, indent=2)
            file.write('\n')


if __name__ == '__main__':
    main()
