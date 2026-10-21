"""Synthetic OANDA input for the task-owned #89 Ubuntu preview only.

Run inside its API container. No supplier credentials or outbound requests.
"""

import argparse
import json
import math
import os
import select as select_io
import sys
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/New_York')


def fixture_starts(frame, stamp, count=1800):
    """Offline fixture calendar only: NY17 weekdays, H4 anchored at 01/05/… NY."""
    if frame not in ('H1', 'H4') or count < 1:
        raise ValueError('Expected H1/H4 and a positive count')
    local_day = datetime.fromtimestamp(stamp / 1000, UTC).astimezone(ZONE).date()
    starts = []
    hours = range(24) if frame == 'H1' else (1, 5, 9, 13, 17, 21)
    while len(starts) < count:
        for hour in hours:
            local = datetime.combine(local_day, datetime.min.time(), ZONE).replace(hour=hour)
            weekday = local.weekday()
            active = weekday < 4 or weekday == 4 and hour < 17 or weekday == 6 and hour >= 17
            candidate = int(local.astimezone(UTC).timestamp() * 1000)
            if active and candidate <= stamp:
                starts.append(candidate)
        local_day -= timedelta(days=1)
    return sorted(starts)[-count:]


def next_fixture_start(frame, start):
    """Find the next legal start, including a weekend or DST transition."""
    if frame not in ('H1', 'H4'):
        raise ValueError('Expected H1/H4')
    candidate = start
    for _ in range(8 * 24):
        candidate += 3600000
        local = datetime.fromtimestamp(candidate / 1000, UTC).astimezone(ZONE)
        weekday, hour = local.weekday(), local.hour
        active = weekday < 4 or weekday == 4 and hour < 17 or weekday == 6 and hour >= 17
        if active and (frame == 'H1' or hour in (1, 5, 9, 13, 17, 21)):
            return candidate
    raise ValueError('Fixture calendar has no next start')


def observe_fixture(meta, frame, stamp):
    """Simulate an empty observation through now, without inventing a future bar.

    The delayed-confirmation tail intentionally has no next candle until rollover.
    Keep the synthetic observation connected to wall time for cache-only reads.
    This is not supplier/session coverage evidence.
    """
    from alerts import provider_cache as cache
    from alerts.storage import ProviderDataset, transaction

    key = cache.ensure(meta, frame)
    with transaction() as db:
        dataset = db.get(ProviderDataset, key)
        if not dataset.coverage:
            raise RuntimeError('Seed the task fixture before observing')
        left = min(dataset.coverage[-1][1], stamp)
    lease = cache.claim(key)
    if lease is None:
        return {'frame': frame, 'busy': True}
    try:
        changed = cache.commit_page(key, lease,
            {'bars': [], 'history_boundary': False, 'coverage': [[left, stamp+1]]},
            stamp+1, stamp, latest=True)
        assert not changed
    finally:
        cache.release(key, lease)
    return {'frame': frame, 'coverage_through': stamp+1, 'freshness_simulated': True}


def main():
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts.native_series import DEFAULTS
    from alerts.oanda_candles import native_bar
    from alerts.storage import (
        MarketCatalog,
        Preference,
        ProviderBar,
        ProviderDataset,
        now_ms,
        transaction,
    )
    from sqlalchemy import select

    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['seed', 'equivalent', 'correct', 'tail', 'rollover', 'expire', 'observe'])
    parser.add_argument('--frame', choices=['H1', 'H4'], default='H1')
    parser.add_argument('--rollover-ready', action='store_true',
                        help='Leave the already-started latest bar for the rollover stage')
    parser.add_argument('--watch-seconds', type=int, default=0,
                        help='Observe both frames every 2s until stdin closes or this budget ends')
    args = parser.parse_args()
    if os.getenv('MW_PREVIEW_TASK') != 'mw-issue89-20261021':
        raise SystemExit('Requires the isolated issue89 preview; never run against production')
    if args.operation == 'seed':
        with transaction() as db:
            db.merge(MarketCatalog(id='OANDA:AUD_JPY', source='oanda', symbol='AUD_JPY',
                label='AUD/JPY acceptance fixture', asset_type='CURRENCY', precision=3,
                calendar='ny17', available=True, metadata_json={}))
    meta = upstream.metadata('OANDA:AUD_JPY')
    if args.operation == 'observe':
        deadline = time.monotonic() + min(900, max(0, args.watch_seconds))
        iterations = 0
        while True:
            records = [observe_fixture(meta, frame, now_ms()) for frame in ('H1', 'H4')]
            iterations += 1
            if not args.watch_seconds:
                print(json.dumps(records))
                return
            if iterations == 1:
                print(json.dumps({'observer': 'ready', 'frames': records,
                                  'interval_seconds': 2, 'max_seconds': args.watch_seconds}), flush=True)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select_io.select([sys.stdin], [], [], min(2, remaining))
            if readable and not sys.stdin.readline():
                break
        print(json.dumps({'observer': 'stopped', 'iterations': iterations}), flush=True)
        return
    frames = ['H1', 'H4'] if args.operation == 'seed' else [args.frame]
    records = []
    for frame in frames:
        key = cache.ensure(meta, frame)
        stamp = now_ms()
        if args.operation == 'seed':
            starts = fixture_starts(frame, stamp, 1801 if args.rollover_ready else 1800)
            if args.rollover_ready:
                starts = starts[:-1]
            bars = []
            for i, start in enumerate(starts):
                value = 150 + 3 * math.sin(i / 12) + math.sin(i / 4) / 3 + i / 10000
                bars.append(native_bar(start=start, frame=frame,
                    parameters=DEFAULTS, complete=i < len(starts)-1, volume=100+i % 20,
                    open=f'{value:.3f}', high=f'{value+.4:.3f}',
                    low=f'{value-.4:.3f}', close=f'{value+.1:.3f}'))
            payload = {'bars': bars, 'history_boundary': True,
                       'coverage': [[bars[0]['start'], max(bars[-1]['end'], stamp+1)]],
                       'revalidation': True}
        elif args.operation == 'expire':
            with transaction() as db:
                for record in db.scalars(select(Preference).where(Preference.key.startswith('provider-display:'))):
                    if record.value['content']['dataset'] == key:
                        record.value = {**record.value, 'expires': 0}
            records.append({'frame': frame, 'expired': True})
            continue
        else:
            with transaction() as db:
                dataset = db.get(ProviderDataset, key)
                epoch = dataset.metadata_json['indicator_history_epoch']
                rows = list(db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key)
                            .order_by(ProviderBar.start.desc()).limit(200)))[::-1]
                bars = [dict(row.payload) for row in rows]
            if args.operation == 'equivalent':
                bars = bars[:-1]
                for bar in bars:
                    bar.pop('source_confirmed', None)
                    bar.pop('coverage_complete', None)
                    bar['close'] += '0' if '.' in bar['close'] else '.0'
            elif args.operation == 'correct':
                bars = [bars[-30]]
                bars[0]['close'] = str(float(bars[0]['close']) + .125)
            else:
                bars = [bars[-1]]
                bars[0]['close'] = str(float(bars[0]['close']) + .025)
                if args.operation == 'rollover':
                    next_start = next_fixture_start(frame, bars[0]['start'])
                    if next_start > stamp:
                        raise RuntimeError('Next fixture bar is in the future; seed --rollover-ready')
                    bars[0].update(complete=True, source_confirmed=True, coverage_complete=True,
                                   volume_complete=True)
                    bars.append(native_bar(start=next_start, frame=frame, parameters=DEFAULTS,
                        complete=False, volume=bars[0]['volume'],
                        **{key: bars[0][key] for key in ('open', 'high', 'low', 'close')}))
            payload = {'bars': bars, 'history_boundary': False,
                       'coverage': [[bars[0]['chart_time'], bars[-1]['end']]]}
        lease = cache.claim(key)
        if lease is None:
            raise RuntimeError('Task dataset is busy')
        try:
            changed = cache.commit_page(key, lease, payload, payload['coverage'][-1][1], stamp,
                                        latest=True)
        finally:
            cache.release(key, lease)
        with transaction() as db:
            dataset = db.get(ProviderDataset, key)
            after = dataset.metadata_json['indicator_history_epoch']
            if args.operation == 'equivalent':
                assert not changed and after == epoch
            elif args.operation == 'correct':
                assert changed and after != epoch
        records.append({'frame': frame, 'operation': args.operation,
                        'changed': len(changed), 'epoch_changed': args.operation != 'seed' and after != epoch,
                        'first': payload['bars'][0]['start'], 'last': payload['bars'][-1]['start'],
                        'freshness_simulated': True})
    print(json.dumps(records))


if __name__ == '__main__':
    main()
