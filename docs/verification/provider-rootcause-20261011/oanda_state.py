"""Read-only actual demand routing and authoritative source state."""
import json
from contextlib import contextmanager
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from alerts.config import settings
from alerts import live_pricing
from alerts.storage import now_ms

stamp=now_ms()
target='7fd3d31e7c7c0e43be3df53eb494e5e2c8fc4d0e408f6b213049e6c09e0cf764'
out={"at":stamp,"database_read_only":True}
with create_engine(settings.database_url).connect() as connection:
    connection.execute(text('SET TRANSACTION READ ONLY'))
    @contextmanager
    def readonly():
        with Session(bind=connection) as db:
            yield db
    live_pricing.transaction=readonly
    desired=live_pricing.desired_datasets(settings.oanda_account_id)
    out['routing']={"target_in_desired":any(v.key==target for v in desired.values()),
        "desired_symbols":sorted(desired),"session_states":live_pricing.session_states(desired)}
    out['provider_status']=live_pricing.provider_status()
    out['live_states']=[dict(row) for row in connection.execute(text('''
        SELECT dataset_id,epoch,connection,heartbeat_at,confirmed_end,ready,error,received_at,
        quote->>'tradeable' AS quote_tradeable,quote->>'source_time' AS quote_source_time
        FROM market_live_states WHERE dataset_id=:target'''),{'target':target}).mappings()]
    out['target_bars']=[dict(row) for row in connection.execute(text('''
        SELECT timeframe,max("end") AS latest_end FROM candles WHERE instrument_id=(
        SELECT instrument_id FROM market_datasets WHERE id=:target) AND timeframe='M1' GROUP BY timeframe
        '''),{'target':target}).mappings()]
    out['recent_health']=[dict(row) for row in connection.execute(text('''
        SELECT at,kind,details->>'state' AS state,details->>'error' AS error
        FROM audit_events WHERE details->>'dataset'=:target
        AND kind IN ('pricing_health','pricing_recovered','pricing_connection') ORDER BY at DESC LIMIT 12
        '''),{'target':target}).mappings()]
print(json.dumps(out,ensure_ascii=False,indent=2))
