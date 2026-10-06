"""Small published-alert baseline, SQLite memory only; no API or notification I/O."""
import os

if os.environ.get('ALERTS_DATABASE_URL')!='sqlite:///:memory:':
    raise SystemExit('Use explicit SQLite memory database for this logic probe')

import json
import argparse
import time
from collections import Counter
from datetime import UTC,datetime

from sqlalchemy import event,select
from alerts import storage as s,managed_dataset as m
from alerts.chart_alert_service import AlertConfig,create,current_version
from alerts.chart_alert_worker import stored_rows,evaluate


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--baseline',action='store_true',help='Record old duplicate-read behavior instead of optimized contract')
    args=parser.parse_args()
    s.bootstrap()
    start=s.ms(datetime(2026,9,28,tzinfo=UTC))
    now=start+120*60000+5000
    with s.transaction() as db:
        inst=db.get(s.Instrument,'BTCUSDT')
        m.join(db,inst,start,now)
        db.add(s.MarketCoverage(instrument_id=inst.id,source=inst.source,basis=inst.basis,start=start,end=now-5000))
        db.add_all([s.Bar(instrument_id=inst.id,timeframe='M1',start=start+i*60000,end=start+(i+1)*60000,
            open=10,high=11,low=9,close=10,complete=True,observed_at=now,received_at=now) for i in range(120)])
        db.flush()
        m.publish_frame(db,inst,db.get(s.ChartHistoryPlan,inst.id),'M1',now)
        config=AlertConfig.model_validate(dict(name='Issue13 published input',instrument=inst.id,source=inst.source,
            timeframe='M1',published=True,calculation_origin=start+60*60000,
            condition=dict(relation='cross_up',right=dict(kind='constant',value=1000)),notify_web=False,notify_ntfy=False))
        alert=create(db,'issue13-alert-read',config,at=now).id
        # Staging-only correction must never leak into the published alert price.
        row=db.scalar(select(s.Bar).where(s.Bar.instrument_id==inst.id,s.Bar.timeframe=='M1').order_by(s.Bar.start.desc()).limit(1))
        row.high=row.close=99
    counts=Counter()
    def count(conn,cursor,statement,*args):
        counts['sql']+=1
        if 'FROM candles' in statement: counts['staging_reads']+=1
        if 'FROM chart_published_bars' in statement: counts['published_reads']+=1
    event.listen(s.engine,'before_cursor_execute',count)
    begun=time.monotonic()
    try:
        with s.transaction() as db:
            record=db.get(s.ChartAlert,alert)
            rows,meta=stored_rows(db,current_version(db,record),config,now)
            assert len(rows)==60 and rows[0]['start']==start+60*60000
            assert all(row['close']=='10.0000000000' and row['observed_at']==now for row in rows)
            assert meta['source']=='binance' and rows[-1]['close']!='99'
        input_counts=dict(counts)
        counts.clear()
        events=[]
        for _ in range(3):
            with s.transaction() as db:
                events.extend(evaluate(db,alert,now=now))
        assert not events
        with s.transaction() as db:
            state=db.get(s.ChartAlert,alert)
            assert state.count==0
    finally:
        event.remove(s.engine,'before_cursor_execute',count)
    print(json.dumps(dict(scenario='published_alert',rows=len(rows),staging_correction_hidden=True,
        stored_rows_queries=input_counts,evaluate_queries=dict(counts),evaluate_repetitions=3,
        elapsed=time.monotonic()-begun,scope='SQLite logic and duplicate read evidence only; not PostgreSQL CPU attribution'),indent=2))
    if args.baseline:
        assert input_counts.get('staging_reads',0)>0,'Baseline no longer has duplicate staging reads'
    else:
        assert input_counts.get('staging_reads',0)==0 and counts.get('staging_reads',0)==0,'BUG: published alert reads and discards staging history'


if __name__=='__main__': main()
