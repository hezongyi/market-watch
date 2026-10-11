import json
from datetime import UTC, datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from alerts.storage import Base, Instrument, MarketDataset
from alerts.market_calendar import calendar_rows, session_status
engine=create_engine('sqlite://')
Base.metadata.create_all(engine)
identity={'source':'dukascopy','channel':'python','environment':'historical','provider_symbol':'XAU/USD','account_scope':'public','quote_basis':'bid','calendar_version':'fixture-v1'}
with Session(engine) as db:
 db.add(Instrument(id='scope-python',label='Python gold',source='dukascopy',symbol='XAU/USD',basis='bid',calendar='ny17',precision=3))
 db.add(MarketDataset(id='python-data',instrument_id='scope-python',logical_symbol='XAUUSD',identity=identity,volume_kind='unavailable'))
 db.commit()
 moment=datetime(2026,10,10,12,tzinfo=UTC)
 result={'identity':identity,'actual_session':session_status('dukascopy','XAU/USD',int(moment.timestamp()*1000),metadata={'source_identity':identity}),
 'calendar_rows':[{k:r.get(k) for k in ('row_id','mappings','status','scope','market_session')} for r in calendar_rows(db=db,source='dukascopy',query='XAUUSD',as_of=moment)]}
 print(json.dumps(result,ensure_ascii=False,indent=2))
 assert result['actual_session']['market_session']=='unknown'
 assert len(result['calendar_rows'])==1 and result['calendar_rows'][0]['status']=='verified'
