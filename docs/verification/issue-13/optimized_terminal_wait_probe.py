"""Repeat only censored live windows, stopping input then draining every target.

Original timed evidence is retained. This supplementary run cannot erase an
original wait above 10 seconds; it resolves small unfinished tail intervals.
"""

import json
import os
from pathlib import Path

import pg_baseline as b


def main():
    root=Path('/results/terminal-wait')
    if root.exists():
        raise SystemExit('Terminal wait evidence already exists')
    root.mkdir()
    original=Path('/performance')
    required=[]
    for scenario in ('live','revision'):
        for repetition in range(1,4):
            report=json.loads((original/f'{scenario}-{repetition}.json').read_text())
            if report.get('final_unserved_ready'):
                required.append((scenario,repetition))
    for scenario,repetition in required:
        b.ROOT=Path('/results')
        b.reset()
        b.ROOT=root
        b.measure(scenario,300,repetition,drain_seconds=30)
        report=json.loads((root/f'{scenario}-{repetition}.json').read_text())
        assert not report['unpublished_events'] and not report['final_unserved_ready']
        assert report['longest_target_wait']<=10
    (root/'result.json').write_text(json.dumps(dict(required=required,completed=len(required),
        source=os.environ.get('ISSUE13_SOURCE'),
        scope='300s same scenario followed by bounded stop-input drain; original failed/censored evidence retained'),indent=2)+'\n')


if __name__=='__main__':
    main()
