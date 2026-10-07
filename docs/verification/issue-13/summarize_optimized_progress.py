"""Read-only in-progress candidate summary; complete acceptance remains separate."""
import json
import os
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE/os.environ.get('ISSUE13_OUTPUT','results/optimized-baseline')


def main():
    state=json.loads((ROOT/'state.json').read_text())
    output=[]
    for repetition in range(1,4):
        for scene in ('idle','live','backfill','revision'):
            p=ROOT/f'{scene}-{repetition}.json'
            if not p.exists():
                continue
            d=json.loads(p.read_text())
            output.append(dict(run=f'{scene}-{repetition}',cpu=d['process_cpu_percent'],
                sql_per_second=d['queries']['total']/d['duration'],
                p95=d['latency_p95'],p99=d['latency_p99'],
                longest_runnable_wait=d['longest_target_wait'],
                backfill_bars_per_second=d['backfill_bars_per_second'],
                remaining_inputs=len(d['unpublished_events']),
                gates=dict(wait=d['longest_target_wait']<=10,
                    idle_cpu=d['process_cpu_percent']<=5 if scene=='idle' else None,
                    idle_sql=d['queries']['total']/d['duration']<=2 if scene=='idle' else None,
                    p95=d['latency_p95']<=15 if d['latency_p95'] is not None else None,
                    p99=d['latency_p99']<=30 if d['latency_p99'] is not None else None,
                    throughput=d['backfill_bars_per_second']>=660.52 if scene=='backfill' else None)))
    print(json.dumps(dict(state=state,completed=len(output),runs=output,
        note='Read-only partial numeric summary; no acceptance verdict, no writes/retries'),indent=2))


if __name__=='__main__':
    main()
