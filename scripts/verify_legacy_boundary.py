"""Real-upstream legacy boundary acceptance, isolated fixture only.

PYTHONPATH=backend .venv/bin/python scripts/verify_legacy_boundary.py
Temporarily installs an impossible BTC plan while workers are stopped, then
checks the actual API's explicit correction. Restores the exact fixture plan.
"""
import json
from pathlib import Path

import httpx
from sqlalchemy import select

from verify_dual_recovery import COMPOSE, ROOT, docker, fixture_environment


def main():
    fixture_environment()
    from alerts.storage import (ChartHistoryPlan, ChartPublishedBar, ImportJob,
                                Preference, now_ms, transaction)

    original = None
    previous_boundary = None
    ident, key = 'BTCUSDT', 'chart_history_boundary:BTCUSDT'
    evidence = {'passed': False, 'database': 'market_watch_dual'}
    fields = ('target_start', 'target_end', 'cursor', 'status', 'updated_at',
              'realtime_enabled', 'realtime_end')

    def visible(db):
        return [(row.start, row.payload) for row in db.scalars(select(ChartPublishedBar).where(
            ChartPublishedBar.instrument_id == ident).order_by(ChartPublishedBar.timeframe, ChartPublishedBar.start))]

    docker(COMPOSE + 'stop realtime-worker chart-history-worker chart-aggregation-worker')
    try:
        with transaction() as db:
            plan = db.get(ChartHistoryPlan, ident)
            original = {field: getattr(plan, field) for field in fields}
            previous_boundary = db.get(Preference, key)
            previous_boundary = previous_boundary.value if previous_boundary else None
            snapshot = visible(db)
            plan.target_start, plan.status = 946684800000, 'pending'  # 2000-01-01
            if previous_boundary:
                db.delete(db.get(Preference, key))
        output = docker(COMPOSE + 'exec -T api python -', source=(
            'import json\nfrom alerts.chart_history_plan import validate_history_start\n'
            'print(json.dumps({"reachable":validate_history_start("BTCUSDT")}))\n'))
        assert json.loads(output)['reachable'] is False
        credentials = json.loads(Path('/home/quant/repos/market-watch/artifacts/local-credentials.json').read_text())
        with httpx.Client(base_url='https://localhost:15453', verify=False, timeout=30) as client:
            client.post('/api/login', json={'password': credentials['password']}).raise_for_status()
            csrf = client.get('/api/session').json()['csrf']
            plans = client.get('/api/market-data/history/plans').json()
            state = next(row for row in plans if row['instrument'] == ident)
            assert state['start'] == 946684800000 and '不可达' in state['boundary_error']
            assert state['realtime_enabled'] == original['realtime_enabled']
            evidence['unreachable'] = {'approved_start': state['start'], 'error': state['boundary_error'],
                                       'realtime_enabled': state['realtime_enabled']}
            response = client.post('/api/market-data/maintenance', headers={'x-csrf-token': csrf},
                                   json={'instrument': ident, 'start_date': '2026-09-30'})
            response.raise_for_status()
            corrected = response.json()
            assert corrected['start'] == 1790726400000 and corrected['boundary_error'] is None
            assert corrected['status'] == 'pending' and corrected['realtime_enabled']
            evidence['explicit_correction'] = {'approved_start': corrected['start'],
                                               'status': corrected['status'], 'boundary_error': None}
        with transaction() as db:
            assert visible(db) == snapshot
        evidence['published_snapshot_unchanged'] = True
        evidence['passed'] = True
    finally:
        if original:
            with transaction() as db:
                plan = db.get(ChartHistoryPlan, ident)
                for field, value in original.items():
                    setattr(plan, field, value)
                current = db.get(Preference, key)
                if previous_boundary is None and current:
                    db.delete(current)
                elif previous_boundary is not None:
                    if current:
                        current.value = previous_boundary
                    else:
                        db.add(Preference(key=key, value=previous_boundary))
            evidence['original_fixture_restored'] = True
        docker(COMPOSE + 'start realtime-worker chart-history-worker chart-aggregation-worker')
        evidence['observed_at'] = now_ms()
        (ROOT / 'docs/verification/dual-container/legacy-boundary-live.json').write_text(
            json.dumps(evidence, indent=2, ensure_ascii=False))
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
