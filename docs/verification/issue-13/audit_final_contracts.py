"""Independently check final-source recovery, coverage and mixed-fault evidence."""

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE / 'results/optimized-r5'


def read(name):
    return json.loads((ROOT / name).read_text())


def main():
    assert read('validation-state.json')['stage'] == 'validation_complete_manual_assessment_pending'
    numeric = read('numeric-assessment.json')
    assert numeric['all_assessed_gates_passed'] and not numeric['missing']
    assert read('recovery-state.json')['stage'] == 'recovery_complete_manual_assessment_pending'
    assert read('final-contract-state.json')['stage'] == 'final_contracts_complete_manual_assessment_pending'
    commit = read('product-source-manifest.json')['commit']
    assert commit == 'ccb2a12b47ea1c9fd06517c2ccf3dec670532ee4'
    pre = read('publication-crash.json')
    assert pre['precommit_process_killed'] and pre['kill_returncode'] == -9
    assert pre['uncommitted_visibility_unchanged'] and pre['pending_generation_retained']
    assert pre['actual_new_process_resumed']
    assert pre['before']['requested'] > pre['before']['processed']
    assert pre['after']['requested'] == pre['after']['processed']
    assert pre['after']['complete_count'] == pre['before']['complete_count'] == 30
    assert pre['after']['row_revision'] == pre['before']['row_revision'] + 1
    rollback = read('application-rollback.json')
    assert rollback['old_application']['legacy_protocol_resumed']
    assert rollback['new_application_resumed'] and rollback['raw_proof_and_additive_schema_retained']
    post = read('final-contracts/publication-postcommit.json')
    assert post['source_commit'] == commit and post['postcommit_process_killed']
    assert post['kill_returncode'] == -9 and post['committed_snapshot_preserved']
    assert post['notification_absent_restart'] == dict(old_hint_absent=True, durable_input_resumed=True)
    assert post['repeated_restart_snapshot_count_revision_stable']
    initial, committed, resumed = (post[k] for k in ('initial', 'committed', 'resumed'))
    assert initial['complete_count'] == committed['complete_count'] == resumed['complete_count'] == 30
    assert committed['row_revision'] == initial['row_revision'] + 1
    assert resumed['row_revision'] == committed['row_revision'] + 1
    assert committed['requested'] == committed['processed']
    assert resumed['requested'] == resumed['processed'] and resumed['pending_jobs'] == 0
    def stable(r):
        return {k: v for k, v in r['payload'].items() if k != 'observed_at'}
    assert stable(initial) != stable(committed) == stable(resumed)
    replay = read('final-contracts/coverage-replay.json')
    assert replay['raw_audits'] == 62522 and replay['raw_structured'] == 27939
    expected = {r['instrument']: r['compatibility_union'] for r in
                json.loads((HERE / 'production-coverage-comparison.json').read_text())['targets']}
    assert {r['instrument'] for r in replay['targets']} == set(expected)
    for row in replay['targets']:
        assert row['equivalent'] and row['audit_reads_after_completion'] == 0
        assert row['intervals'] == expected[row['instrument']]
        assert row['pages'][-1]['complete']
    rotation = read('final-contracts/rotation-faults.json')
    assert rotation['source_commit'] == commit and rotation['targets'] == 90
    assert not rotation['missing'] and not rotation['outstanding_retries'] and not rotation['lock_errors']
    counts = {tuple(r['target']): 0 for r in rotation['rounds']}
    assert len(counts) == 90
    first = {}
    for turn in rotation['turns']:
        if turn['progressed']:
            key = tuple(turn['target'])
            counts[key] += 1
            first.setdefault(key, turn['at'])
    assert all(counts[tuple(r['target'])] == r['count'] >= 2 for r in rotation['rounds'])
    assert first == {tuple(r['target']): r['seconds'] for r in rotation['first_service']}
    maximum = max([r['seconds'] for t in rotation['turns'] for r in t['ready_ages']] +
                  [r['seconds'] for r in rotation['terminal_unserved_ages']])
    assert maximum == rotation['longest_target_wait'] <= 10
    throughput = (rotation['published_bars_after'] - rotation['published_bars_before']) / rotation['duration']
    assert throughput == rotation['backfill_bars_per_second'] > 0
    assert len(rotation['failures']) == sum(t['failed'] for t in rotation['turns']) == 1
    assert rotation['failures'][0]['snapshot_rollback_verified']
    assert rotation['healthy_services_during_lock'] == sum(
        t['progressed'] and t['at'] < rotation['lock']['released'] and t['target'][0] != 'BTCUSDT'
        for t in rotation['turns']) > 0
    assert rotation['healthy_services_during_retry'] == sum(
        t['progressed'] and rotation['failures'][0]['at'] < t['at'] < rotation['failures'][0]['at'] + 2
        and tuple(t['target']) != ('EURUSD', 'M1') for t in rotation['turns']) > 0
    assert rotation['fault_after']['payload']['observed_at'] == rotation['failed_input_observed_at']
    assert rotation['fault_after']['count'] == rotation['fault_before']['count']
    assert rotation['fault_after']['row_revision'] == rotation['fault_before']['row_revision'] + 1
    executed = read('final-contracts/executed-source.json')
    assert executed['product_commit'] == commit
    for name, key, report in (
        ('verify_publication_postcommit.py', 'postcommit_probe_sha256', post),
        ('verify_rotation_faults.py', 'rotation_fault_probe_sha256', rotation),
    ):
        digest = hashlib.sha256((HERE / name).read_bytes()).hexdigest()
        assert digest == executed[key] == report['executed_probe_sha256']
    audit = dict(passed=True, product_commit=commit,
        checks=['precommit kill/restart', 'old application additive-schema rollback',
                'postcommit kill/absent notification/idempotent restart',
                '62522/27939 proof replay', '90-target concurrent lock/retry/backfill wait and historical progress'],
        complete_acceptance=False, scope='Final contracts only; final delivery/environment audit remains separate')
    with (ROOT / 'final-contracts/artifact-audit.json').open('x') as output:
        json.dump(audit, output, indent=2)
        output.write('\n')
    print('Final-contract artifacts independently verified; full completion is not implied')


if __name__ == '__main__':
    main()
