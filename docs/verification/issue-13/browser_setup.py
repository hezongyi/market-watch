"""Reset own fixture before full-lifespan browser services start."""
import json
import time

import pg_baseline as b
from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate

s,m=b.s,b.m
b.reset()
with s.transaction() as db:
    for alert in db.query(s.ChartAlert).filter(s.ChartAlert.status=='active'):
        alert.status='paused'
    # Full wall clock is deliberately used for lifespan/provider/alert threads;
    # the data is synthetic fixed history, not a fresh intrabar source.
    ident='BTCUSDT'
    inst=db.get(s.Instrument,ident)
    config=AlertConfig.model_validate(dict(name='Issue13 browser load',instrument=ident,
        source=inst.source,timeframe='M1',published=True,calculation_origin=b.NOW-5000-120*b.MINUTE,
        condition=dict(relation='cross_up',right=dict(kind='constant',value=100000)),
        notify_web=False,notify_ntfy=False))
    alert_id=create(db,'issue13-browser-'+str(time.time_ns()),config,at=s.now_ms()).id
with s.transaction() as db:
    assert evaluate(db,alert_id,now=int(time.time()*1000))==[]
    row=db.get(s.ChartAlert,alert_id)
    assert row.health in ('ready','stale')
print(json.dumps(dict(synthetic=True,fixture='fixed historical snapshots',alert_count=1,
    alert_health=row.health,scope='No live-source freshness or trigger SLA assertion')),flush=True)
