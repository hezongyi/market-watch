"""Derive a finite, source-reviewed calendar identity from immutable real rows."""
import json
from datetime import UTC,datetime
from sqlalchemy import select
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.history_derivation import derive_version,derive_page
from alerts.history_maintenance import configure
from alerts.history_versions import snapshot_rows
from alerts.domain import calendar_for,scheduled_open
from alerts.storage import transaction,HistoryVersion,MarketDataset,Instrument,DatasetMaintenance
ORIGINAL='25833014-18de-4420-8332-ab21277bc17d'
rev='issue74-real-xau-duka-session-20260817-20261017-v2'
identity=DatasetIdentity(source='dukascopy',channel='python',environment='historical',account_scope='public',
    provider_symbol='XAU/USD',basis='bid',calendar_version=rev)
url='https://www.dukascopy.com/swiss/english/forex/forex-trading-accounts/link/'
profile={'revision':rev,'closures':[],'source_session':{
    **{k:getattr(identity,k) for k in ['source','channel','environment','account_scope','provider_symbol']},
    'timezone':'America/New_York','reviewed_start':'2026-08-17T00:00:00Z','reviewed_end':'2026-10-18T00:00:00Z',
    'evidence_url':url,'applicability':'Dukascopy published regular XAU/USD trading schedule, finite Aug17-Oct17 2026 BID M1 test dataset. Regular closures cross-checked against all immutable source observations; no holiday completeness or public JSON3 feed SLA claimed. US national holiday exceptions remain unknown.',
    'weekly_closures':[{'start':d*1440+17*60,'end':d*1440+18*60} for d in range(4)]
        +[{'start':4*1440+17*60,'end':6*1440+18*60}]}}
with transaction() as db:
    inst=register_dataset(db,identity,logical_symbol='XAUUSD',label='Issue74 XAUUSD 近两个月（真实组合验收）',
        calendar='ny17',precision=3,volume_kind='quantity',volume_unit='source_quantity',
        calendar_profile=profile,asset_class='metal')
    rows=list(snapshot_rows(db,ORIGINAL))
    conflicts=[r['timestamp'] for r in rows if not scheduled_open(datetime.fromtimestamp(r['timestamp']/1000,UTC),calendar_for(inst))]
    assert not conflicts,{'source_observations_inside_declared_closures':len(conflicts)}
    configure(db,identity.key,target_start=1786924800000,timeframes=['M1','M5','M15','M30','H1','H4','D1','W1','MN'],
        frequency='daily',daily_minute=30,overlap_minutes=2880)
    old=db.get(MarketDataset,'d256713739aedf7142510294a5cdf277652304412c493e4aaefeb7aa08c22936')
    db.get(DatasetMaintenance,old.id).paused=True
    db.get(Instrument,old.instrument_id).label='诊断留存 XAUUSD（无来源会话规则）'
    versions=list(db.scalars(select(HistoryVersion).where(HistoryVersion.dataset_id==identity.key)))
    version_id=versions[0].id if versions else derive_version(db,ORIGINAL,identity.key)
    print(json.dumps({'stage':'session_reviewed','dataset_id':identity.key,'version_id':version_id,
        'rows_checked':len(rows),'observations_inside_declared_closures':len(conflicts),'profile':profile}),flush=True)
# The task history worker drains this immutable derivation and artifacts.
