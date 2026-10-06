import os

if os.environ.get("ALERTS_DATABASE_URL") != "sqlite:///:memory:":
    raise SystemExit("Set ALERTS_DATABASE_URL=sqlite:///:memory:; this probe must not use persistent data")

import json
from collections import Counter
from datetime import UTC, datetime
from sqlalchemy import event, select, func
from sqlalchemy.orm import sessionmaker
from alerts import storage as s, managed_dataset as m
from alerts.chart_aggregation import aggregate_once

s.bootstrap()
s.Session = sessionmaker(s.engine, expire_on_commit=False)
start = s.ms(datetime(2026, 9, 28, tzinfo=UTC))
now = start + 30 * 60000 + 5000
m.now_ms = lambda: now
with s.transaction() as db:
    inst = db.get(s.Instrument, 'BTCUSDT')
    m.join(db, inst, start, now)
    db.add(s.MarketCoverage(instrument_id=inst.id, source=inst.source, basis=inst.basis,
                           start=start, end=now-5000))
    for i in range(30):
        db.add(s.Bar(instrument_id=inst.id, timeframe='M1', start=start+i*60000,
                     end=start+(i+1)*60000, open=10, high=11, low=9, close=10,
                     complete=True, observed_at=now, received_at=now))
for _ in range(2 * len(m.FRAMES)):
    m.publish_once()

def snapshot():
    with s.transaction() as db:
        pubs = [(p.instrument_id, p.timeframe, p.start, p.end, p.complete_count,
                 p.revision, p.initialized) for p in db.scalars(select(s.ChartPublication).order_by(s.ChartPublication.timeframe))]
        bars = [(b.timeframe, b.start, b.revision, b.payload) for b in db.scalars(select(s.ChartPublishedBar).order_by(s.ChartPublishedBar.timeframe, s.ChartPublishedBar.start))]
        queues = [db.scalar(select(func.count()).select_from(t)) for t in (s.ChartAggregationJob, s.ChartPublicationJob)]
        return pubs, bars, queues
before = snapshot()
queries = Counter()
@event.listens_for(s.engine, 'before_cursor_execute')
def count(conn, cursor, statement, params, context, many):
    queries['sql_total'] += 1
    if 'FROM candles' in statement: queries['candle_reads'] += 1
    if 'FROM market_data_coverage' in statement: queries['coverage_reads'] += 1
    if statement.startswith('UPDATE chart_publications'): queries['publication_updates'] += 1
    if 'count(' in statement and 'FROM chart_published_bars' in statement: queries['published_count_queries'] += 1
now += 1000
results = [(aggregate_once(), m.publish_once()) for _ in m.FRAMES]
event.remove(s.engine, 'before_cursor_execute', count)
after = snapshot()
print(json.dumps(dict(same_visible_snapshot=before == after, queues=after[-1],
                     cycles=len(results), aggregation_work=sum(a for a,p in results),
                     publication_claims=sum(p for a,p in results), queries=queries), indent=2))
assert before == after and after[-1] == [0, 0], 'fixture is not idle'

from alerts.bar_batch import write_bars
with s.transaction() as db:
    bar = db.scalar(select(s.Bar).where(s.Bar.timeframe == 'M1').order_by(s.Bar.start.desc()).limit(1))
    latest = bar.start
    changed = write_bars(db, 'BTCUSDT', 'M1', [bar.candle()], observed_at=now+1000)
    queued = db.scalar(select(func.count()).select_from(s.ChartPublicationJob))
print(json.dumps(dict(scenario='observation_only', price_changes=len(changed.price), volume_changes=len(changed.volume), publication_jobs=queued)))
with s.transaction() as db:
    inst = db.get(s.Instrument, 'BTCUSDT')
    plan = db.get(s.ChartHistoryPlan, inst.id)
    pub = db.get(s.ChartPublication, (inst.id, 'M1'))
    old_revision = pub.revision
    old_observed = db.get(s.ChartPublishedBar, (inst.id, 'M1', latest)).payload['observed_at']
    outcome = m.publish_frame(db, inst, plan, 'M1', now+1000)
    new_observed = db.get(s.ChartPublishedBar, (inst.id, 'M1', latest)).payload['observed_at']
    print(json.dumps(dict(scenario='publish_observation', return_value=outcome, old_observed=old_observed, new_observed=new_observed, old_revision=old_revision, new_revision=pub.revision)))
    assert new_observed > old_observed and pub.revision > old_revision and outcome is False
from dataclasses import replace
from decimal import Decimal
with s.transaction() as db:
    bar = db.scalar(select(s.Bar).where(s.Bar.timeframe == 'M1').order_by(s.Bar.start).limit(1))
    target = bar.start
    changed = write_bars(db, 'BTCUSDT', 'M1', [replace(bar.candle(), high=Decimal(21), close=Decimal(20))], observed_at=now+2000)
    assert changed.price
with s.transaction() as db:
    inst = db.get(s.Instrument, 'BTCUSDT')
    plan = db.get(s.ChartHistoryPlan, inst.id)
    pub = db.get(s.ChartPublication, (inst.id, 'M1'))
    old_revision = pub.revision
    outcome = m.publish_frame(db, inst, plan, 'M1', now+2000)
    row = db.get(s.ChartPublishedBar, (inst.id, 'M1', target))
    queued = db.scalar(select(func.count()).select_from(s.ChartPublicationJob))
    print(json.dumps(dict(scenario='publish_correction', return_value=outcome, close=row.payload['close'], old_revision=old_revision, new_revision=pub.revision, remaining_jobs=queued)))
    assert Decimal(row.payload['close']) == Decimal(20) and pub.revision > old_revision and outcome is False and queued == 0
