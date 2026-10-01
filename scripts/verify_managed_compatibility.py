"""Managed alert/replay acceptance on genuine local fixture candles.

Runs beside the browser/provider/history load. Creates an internal alert from a
real already-observed crossing, lets the realtime worker evaluate it, then
acknowledges its unsent outbox. No notification sender is ever invoked.
"""
import json
import time
from decimal import Decimal
from pathlib import Path

import httpx
from sqlalchemy import func, select

from verify_dual_recovery import ROOT, COMPOSE, docker, fixture_environment


def main():
    fixture_environment()
    from alerts.service import acknowledge, create_watch
    from alerts.storage import Bar, Notification, Outbox, SignalRow, Watch, now_ms, transaction

    runtime = json.loads(docker(COMPOSE + 'exec -T api python -', source=(
        'import json\nfrom alerts.config import settings\n'
        'print(json.dumps({"delivery_enabled":settings.delivery_enabled}))\n')))
    assert runtime['delivery_enabled'] is False
    evidence = {'passed': False, 'database': 'market_watch_dual', 'delivery_enabled': False}
    watch_id = None
    try:
        with transaction() as db:
            rows = list(db.scalars(select(Bar).where(Bar.instrument_id == 'BTCUSDT',
                Bar.timeframe == 'M1', Bar.complete.is_(True)).order_by(Bar.start.desc()).limit(50)))[::-1]
            previous, following = next((a, b) for a, b in zip(rows, rows[1:])
                                       if a.end == b.start and a.close != b.close)
            level = (previous.close + following.close) / 2
            direction = 'buy' if following.close > previous.close else 'sell'
            watch = create_watch(db, 'BTCUSDT', '隔离验收内部监控',
                {'kind': 'price', 'timeframe': 'M1', 'level': str(level), 'direction': direction},
                armed_at=previous.end, use_history=True)
            watch_id = watch.id
            armed = now_ms()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            with transaction() as db:
                signal = db.scalar(select(SignalRow).where(SignalRow.watch_id == watch_id))
                if signal:
                    assert signal.instrument_id == 'BTCUSDT'
                    assert signal.price == following.close and signal.occurred_at == following.end
                    assert db.get(Watch, watch_id).status == 'triggered'
                    note = db.scalar(select(Notification).where(Notification.signal_id == signal.id))
                    outbox = db.scalar(select(Outbox).where(Outbox.notification_id == note.id))
                    assert outbox.status == 'pending'
                    acknowledge(db, note.id)
                    assert outbox.status == 'cancelled'
                    evidence['alert'] = {'watch_id': watch_id, 'price': str(signal.price),
                        'occurred_at': signal.occurred_at, 'worker_dispatch_ms': signal.created_at - armed,
                        'outbox_cancelled_without_delivery': True,
                        'caveat': 'Historical real-price crossing, realtime-worker dispatch latency; not close-to-notification network latency.'}
                    break
            time.sleep(1)
        else:
            raise AssertionError('Realtime worker failed to evaluate the managed alert within 90s')
        with httpx.Client(base_url='https://localhost:15453', verify=False, timeout=30) as client:
            credentials = json.loads(Path('/home/quant/repos/market-watch/artifacts/local-credentials.json').read_text())
            client.post('/api/login', json={'password': credentials['password']}).raise_for_status()
            csrf = client.get('/api/session').json()['csrf']
            headers = {'x-csrf-token': csrf}
            with transaction() as db:
                candles = list(db.scalars(select(Bar).where(Bar.instrument_id == 'BTCUSDT',
                    Bar.timeframe == 'M5', Bar.complete.is_(True)).order_by(Bar.start.desc()).limit(10)))[::-1]
            left, right = candles[0].end, candles[-1].end
            response = client.post('/api/replays', headers=headers, json={
                'instrument_id': 'BTCUSDT', 'timeframe': 'M5', 'start': left, 'end': right})
            response.raise_for_status()
            run = response.json()
            assert all(row['end'] <= run['cursor'] for row in run['bars'])
            response = client.post('/api/replays/' + run['id'] + '/step', headers=headers, json={'count': 1})
            response.raise_for_status()
            stepped = response.json()
            assert stepped['cursor'] == left + 300000
            assert all(row['end'] <= stepped['cursor'] for row in stepped['bars'])
            matching = next(row for row in stepped['bars'] if row['end'] == stepped['cursor'])
            real = next(row for row in candles if row.end == stepped['cursor'])
            assert Decimal(matching['close']) == real.close
            exported = client.get('/api/replays/' + run['id'] + '/export').json()
            assert exported['simulated'] and exported['cursor'] == stepped['cursor']
            restored = client.get('/api/replays/' + run['id']).json()
            assert restored['cursor'] == stepped['cursor']
            provider = client.post('/api/replays', headers=headers, json={
                'instrument_id': 'MWP:BTCUSDT', 'timeframe': 'M5', 'start': left, 'end': right})
            assert provider.status_code == 422
            provider_alert = client.post('/api/watches', headers=headers, json={
                'instrument_id': 'MWP:BTCUSDT', 'name': 'invalid provider', 'kind': 'price',
                'timeframe': 'M1', 'level': str(level)})
            assert provider_alert.status_code == 422
            evidence['replay'] = {'id': run['id'], 'source': 'managed candles', 'future_hidden': True,
                'step_minutes': 5, 'real_ohlc_matches': True, 'export_restore': True,
                'provider_replay_rejected': True, 'provider_alert_rejected': True}
        with transaction() as db:
            assert db.scalar(select(func.count()).select_from(SignalRow).where(SignalRow.watch_id == watch_id)) == 1
        evidence['passed'] = True
    finally:
        if watch_id:
            with transaction() as db:
                watch = db.get(Watch, watch_id)
                if watch.status == 'active':
                    watch.status = 'cancelled'
                signal = db.scalar(select(SignalRow).where(SignalRow.watch_id == watch_id))
                if signal:
                    note = db.scalar(select(Notification).where(Notification.signal_id == signal.id))
                    acknowledge(db, note.id)
        evidence['observed_at'] = now_ms()
        (ROOT / 'docs/verification/dual-container/managed-compatibility-live.json').write_text(
            json.dumps(evidence, indent=2, ensure_ascii=False))
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
