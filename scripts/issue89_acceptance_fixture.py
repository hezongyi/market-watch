"""Synthetic OANDA input for the task-owned #89 Ubuntu preview only.

Run inside its API container. No supplier credentials or outbound requests.
"""

import argparse
import json
import math
import os

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['seed', 'equivalent', 'correct', 'tail', 'rollover', 'expire'])
    parser.add_argument('--frame', choices=['H1', 'H4'], default='H1')
    args = parser.parse_args()
    if os.getenv('MW_PREVIEW_TASK') != 'mw-issue89-20261021':
        raise SystemExit('Requires the isolated issue89 preview; never run against production')
    if args.operation == 'seed':
        with transaction() as db:
            db.merge(MarketCatalog(id='OANDA:AUD_JPY', source='oanda', symbol='AUD_JPY',
                label='AUD/JPY acceptance fixture', asset_type='CURRENCY', precision=3,
                calendar='ny17', available=True, metadata_json={}))
    meta = upstream.metadata('OANDA:AUD_JPY')
    frames = ['H1', 'H4'] if args.operation == 'seed' else [args.frame]
    records = []
    for frame in frames:
        key = cache.ensure(meta, frame)
        step = upstream.FRAME_MS[frame]
        stamp = now_ms()
        if args.operation == 'seed':
            tail = stamp // step * step
            bars = []
            for i in range(1800):
                value = 150 + 3 * math.sin(i / 12) + math.sin(i / 4) / 3 + i / 10000
                bars.append(native_bar(start=tail-(1799-i)*step, frame=frame,
                    parameters=DEFAULTS, complete=i < 1799, volume=100+i % 20,
                    open=f'{value:.3f}', high=f'{value+.4:.3f}',
                    low=f'{value-.4:.3f}', close=f'{value+.1:.3f}'))
            payload = {'bars': bars, 'history_boundary': True, 'coverage': [[0, tail+step]]}
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
                    bars[0].update(complete=True, source_confirmed=True, coverage_complete=True,
                                   volume_complete=True)
                    bars.append({**bars[0], 'start': bars[0]['end'],
                        'chart_time': bars[0]['end'], 'end': bars[0]['end']+step,
                        'complete': False, 'source_confirmed': False,
                        'coverage_complete': False, 'volume_complete': False})
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
            # Keep this offline synthetic fixture fresh throughout browser testing.
            dataset.latest_at = stamp + 3600000
            after = dataset.metadata_json['indicator_history_epoch']
            if args.operation == 'equivalent':
                assert not changed and after == epoch
            elif args.operation == 'correct':
                assert changed and after != epoch
        records.append({'frame': frame, 'operation': args.operation,
                        'changed': len(changed), 'epoch_changed': args.operation != 'seed' and after != epoch})
    print(json.dumps(records))


if __name__ == '__main__':
    main()
