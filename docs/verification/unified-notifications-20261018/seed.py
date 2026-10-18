from decimal import Decimal
from alerts.config import settings
from alerts.storage import AdvancedWorkspace, HistoryVersion, Preference, transaction
from alerts import history_versions as history
from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
from alerts.market_datasets import register_dataset
assert settings.database_application_name == 'mw-issue75-v2-20261018' and not settings.delivery_enabled
identity=DatasetIdentity(source='dukascopy',channel='python',environment='historical',account_scope='public',provider_symbol='EUR/USD',basis='bid',calendar_version='issue75-d1-fixed-v1')
start,end=1791158400000,1792195200000
with transaction() as db:
    marker=db.get(Preference,'acceptance.issue75.chart')
if marker:
    print('reuse independent chart fixture');raise SystemExit()
with transaction() as db:
    instrument=register_dataset(db,identity,logical_symbol='EURUSD',label='Issue75 D1 合成历史',calendar='utc0',precision=5,volume_kind='quantity',volume_unit='source_quantity')
    version=history.create_version(db,identity.key,start,end)
class Adapter:
    def page(self,identity,start,end):
        right=end
        rows=tuple(MinuteRow(timestamp=at,open=str(Decimal('1.1')+Decimal(at//60000%300)/100000),high='1.12',low='1.09',close=str(Decimal('1.1001')+Decimal(at//60000%300)/100000),volume='10',complete=True) for at in range(start,right,60000))
        return CandleBatch(identity=identity,window_start=start,window_end=right,observed_at=right+60000,result=RequestResult(status='data'),rows=rows,checkpoint=right,volume_kind='quantity',volume_unit='source_quantity')
for _ in range(40):
    history.import_page(Adapter(),version_id=version)
    with transaction() as db:
        row=db.get(HistoryVersion,version)
        if row.error:raise RuntimeError(row.error)
        if row.status=='published':request_artifacts(db,row,['M1','H1']);break
else:raise RuntimeError('fixture not published')
while artifact_tick(version):pass
with transaction() as db:
    for ident in ('mw75-a','mw75-b'):
        db.add(AdvancedWorkspace(id=ident,name=ident+' 合成验收',document={'engine':'tv31','schemaVersion':1,'symbol':'MWH:'+version,'interval':'60'}))
    db.add(Preference(key='acceptance.issue75.chart',value={'version':version,'synthetic':True,'outbound':False}))
print('independent fixed history and two workspaces ready')
