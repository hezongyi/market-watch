"""Synthetic R2 state, confined to this task's isolated PostgreSQL database."""
import importlib.util
import json
import os
import sys
from decimal import Decimal
from pathlib import Path

from alerts.config import settings
from alerts.storage import (
    Bar,
    ChartAlert,
    Instrument,
    Preference,
    SignalRow,
    Watch,
    now_ms,
    transaction,
)
from sqlalchemy import select
from sqlalchemy.engine import make_url


def guard():
    url = make_url(settings.database_url)
    if (os.environ.get('MW_ACCEPTANCE_TASK') != 'mw-single-frontend-20261026'
            or url.host != 'postgres' or url.database != 'acceptance'
            or settings.delivery_enabled or settings.yahoo_enabled or settings.oanda_stream_enabled):
        raise ValueError('Only the isolated synthetic acceptance database is allowed')


def run(action):
    guard()
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / 'backend/tests'))
    from alerts.chart_alert_service import consume, create
    from test_chart_alert_service import config, sample
    from test_legacy_retirement import old_event, old_watch

    def background(db, ids):
        if ids.get('background'):
            return ids
        start = (now_ms() // 60_000 - 2) * 60_000
        db.get(Instrument, 'BTCUSDT').enabled = True
        db.get(Instrument, 'D1_BTCUSDT').enabled = True
        db.add(Bar(instrument_id='BTCUSDT', timeframe='M1', start=start,
                   end=start+60_000, open=Decimal(9), high=Decimal(9), low=Decimal(9),
                   close=Decimal(9), complete=True, observed_at=start+60_000))
        rule=create(db, 'single-frontend-background', config(instrument='BTCUSDT',source='binance',timeframe='M1',notify_ntfy=True),at=start+60_000)
        return {**ids, 'background':rule.id, 'background_start':start}

    if action == 'tokens':
        from alerts.mcp.auth import issue
        return {'write':issue('single-frontend-r2',['market:read','alerts:read','alerts:write','charts:read'],now_ms()+86400000),
                'read':issue('single-frontend-r2-read',['market:read','alerts:read'],now_ms()+86400000)}
    if action == 'seed':
        spec = importlib.util.spec_from_file_location('synthetic_d1', root / 'deploy/ubuntu/d1_seed.py')
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        fixture.seed('d1-v1-single-frontend-r2')
        with transaction() as db:
            marker = db.get(Preference, 'single-frontend.r2')
            if marker:
                marker.value = background(db, marker.value)
                return marker.value
            instrument = db.get(Instrument, 'EURUSD')
            instrument.enabled = True
            watch = old_watch(db)
            note, task = old_event(db, watch)
            modern = create(db, 'single-frontend-r2', config(notify_ntfy=True, max_triggers=3), at=0)
            consume(db, modern.id, sample(0, 9), detected_at=0)
            result = background(db, {'synthetic': True, 'old_watch': watch.id,
                'old_notification':note.id, 'old_signal':note.signal_id,
                'old_outbox':task.id, 'alert':modern.id})
            db.add(Preference(key='single-frontend.r2', value=result))
            return result
    with transaction() as db:
        ids = db.get(Preference, 'single-frontend.r2').value
        if action == 'background':
            start=ids['background_start']+60_000
            if not db.scalar(select(Bar).where(Bar.instrument_id=='BTCUSDT',Bar.timeframe=='M1',Bar.start==start)):
                db.add(Bar(instrument_id='BTCUSDT',timeframe='M1',start=start,end=start+60_000,
                           open=Decimal(11),high=Decimal(11),low=Decimal(11),close=Decimal(11),complete=True,observed_at=start+60_000))
        if action == 'advance':
            consume(db, ids['alert'], sample(1, 11), detected_at=300001)
            consume(db, ids['alert'], sample(1, 11), detected_at=300001)
        if action == 'retire':
            from alerts.retire_legacy import retire
            first = retire(db, apply=True)
            second = retire(db, apply=True)
            assert first['verified'] and second['counts'] == {'watches': 0, 'notifications': 0}
        alert = db.get(ChartAlert, ids['alert'])
        signals = list(db.scalars(select(SignalRow).where(SignalRow.chart_alert_id == alert.id)))
        background=db.get(ChartAlert,ids.get('background')) if ids.get('background') else None
        return {**ids, 'background_count': background.count if background else None, 'background_checkpoint':background.state if background else None, 'count': alert.count, 'checkpoint': alert.state,
                'old_status': db.get(Watch, ids['old_watch']).status,
                'signal': signals[0].id if signals else None, 'at': now_ms()}


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1]), ensure_ascii=False))
