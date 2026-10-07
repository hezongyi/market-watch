"""Validate candidate raw measurements; idle targets are not runnable work."""

import argparse
import json
import subprocess

from run_optimized_baseline import OUTPUT, PREFIX, command


def audit(scenario, repetition):
    name = f'{scenario}-{repetition}'
    result = json.loads((OUTPUT / (name + '.json')).read_text())
    raw = [json.loads(line) for line in (OUTPUT / (name + '.jsonl')).read_text().splitlines()]
    pg = json.loads((OUTPUT / (name + '-sql.json')).read_text())
    assert result['duration'] >= 300 and len(raw) == result['cycles'] and raw
    assert raw[-1]['queries'] == result['queries']
    assert all(a['at'] < b['at'] for a, b in zip(raw, raw[1:]))
    assert abs(max(row['target_wait'] for row in raw) - result['longest_target_wait']) < 1e-8
    assert abs(100 * result['process_cpu_seconds'] / result['duration'] - result['process_cpu_percent']) < 1e-8
    assert pg['statements']
    assert all(row['target'] is None or row['publish_claim'] for row in raw)
    if scenario == 'idle':
        assert result['visible_unchanged'] and result['before'] == result['after']
        assert not any(row['publish_claim'] or row['aggregate'] or row['ready_targets'] for row in raw)
        assert not result['queries'].get('audit_reads', 0)
        assert not result['queries'].get('candle_reads', 0)
        assert not result['queries'].get('publication_updates', 0)
    if scenario in ('live', 'revision'):
        assert len(result['events']) >= 25, 'Too few completed events'
        assert not result['unpublished_events'], 'Input failed to become visible'
    return dict(run=name, scenario=scenario, cpu_percent=result['process_cpu_percent'],
        sql_per_second=result['queries']['total'] / result['duration'],
        audit_reads=result['queries'].get('audit_reads', 0),
        latency_p95=result['latency_p95'], latency_p99=result['latency_p99'],
        longest_runnable_wait=result['longest_target_wait'],
        backfill_bars_per_second=result['backfill_bars_per_second'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--complete', action='store_true')
    args = parser.parse_args()
    runs, missing = [], []
    for scenario in ('idle', 'live', 'backfill', 'revision'):
        for repetition in range(1, 4):
            if (OUTPUT / f'{scenario}-{repetition}.json').exists():
                runs.append(audit(scenario, repetition))
            else:
                missing.append(f'{scenario}-{repetition}')
    if args.complete:
        assert not missing
        assert json.loads((OUTPUT / 'state.json').read_text())['status'] == 'complete'
        ident = subprocess.check_output(command(PREFIX + ['ps', '-a', '-q', 'postgres']), text=True).strip()
        state = json.loads(subprocess.check_output(command(['docker', 'inspect', '--format', '{{json .State}}', ident]), text=True))
        assert not state['Running'] and not state['OOMKilled'] and state['ExitCode'] == 0
    report = dict(complete=not missing, runs=runs, missing=missing,
        note='Consistency audit. Performance thresholds and downstream correctness are separately assessed.')
    print(json.dumps(report, indent=2))
    if args.complete:
        with (OUTPUT / 'measurement-audit.json').open('x') as file:
            json.dump(report, file, indent=2)
            file.write('\n')


if __name__ == '__main__':
    main()
