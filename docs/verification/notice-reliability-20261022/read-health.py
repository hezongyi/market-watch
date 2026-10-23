import json
from sqlalchemy import select,text
from alerts.storage import Session,LiveState,MarketDataset,Preference,now_ms
from alerts.live_confirmation import health,sampling_evidence
with Session() as db:
 db.execute(text('SET TRANSACTION READ ONLY'))
 rows=[]
 for state in db.scalars(select(LiveState)):
  dataset=db.get(MarketDataset,state.dataset_id)
  if dataset.logical_symbol not in ('EURUSD','XAUUSD','USDCAD'):continue
  confirmation=health(db,state)
  rows.append({'symbol':dataset.logical_symbol,'ready':state.ready,'connection':state.connection,'sampling_error':state.error,'received_at':state.received_at,'confirmed_end':state.confirmed_end,'next_confirm_at':state.next_confirm_at,'confirmation':confirmation,'sampling_evidence':sampling_evidence(db,state)})
 print(json.dumps({'at':now_ms(),'rows':rows}))
 db.rollback()
