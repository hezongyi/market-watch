"""Sanitize the private observer output into comparable aggregate evidence."""
import json
import statistics
import sys
from pathlib import Path


def summarize(directory):
    rows = json.loads((directory / 'observations.json').read_text())
    first, last = rows[0], rows[-1]
    cpu = {name: round(statistics.mean(row['cpu'][name] for row in rows[1:]), 2)
           for name in first['cpu']}
    attempts = {row['id']: row['attempts'] for row in first['shadow']}
    result = dict(start=first['at'], end=last['at'], samples=len(rows),
                  cpu_percent_one_core=cpu, cpu_cores=round(sum(cpu.values()) / 100, 3),
                  host_cpu_percent_4_cores=round(sum(cpu.values()) / 4, 2),
                  workload_first=first['workload'], workload_last=last['workload'],
                  workload_constant=all(row['workload'] == first['workload'] for row in rows),
                  shadow_attempt_increase=sum(row['attempts'] - attempts.get(row['id'], 0)
                                              for row in last['shadow']),
                  shadow_states_last=[row['state'] for row in last['shadow']],
                  new_published_rows=last['published']['count'] - first['published']['count'],
                  publication_revision_increase=last['published']['revisions'] - first['published']['revisions'],
                  aggregation_queue_empty_samples=sum(not row['jobs'] for row in rows),
                  publication_jobs_last=last['publication_jobs'],
                  db_commits=last['db_stats']['commits'] - first['db_stats']['commits'],
                  db_row_updates=last['db_stats']['updated'] - first['db_stats']['updated'])
    diff = json.loads((directory / 'bar-changes.json').read_text())
    result['sixteen_second_diff'] = dict(
        added=diff['added'], rows_changed=sum(row['rows_changed'] for row in diff['groups']),
        revision_increase=sum(row['revision_delta'] for row in diff['groups']),
        observation_only_rows=sum(row['rows_changed'] for row in diff['groups']
                                  if set(row['field_changes']) == {'observed_at'}))
    return result


root = Path(sys.argv[1])
result = {name: summarize(root / name) for name in ('before', 'after')}
result['cpu_reduction_percent'] = round(
    (1 - result['after']['cpu_cores'] / result['before']['cpu_cores']) * 100, 1)
print(json.dumps(result, ensure_ascii=False, indent=2))
