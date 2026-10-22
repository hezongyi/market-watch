import json
import time

from sqlalchemy import text
from alerts.storage import engine

start=time.time()
activity=text("""
SELECT pid,state,wait_event_type,wait_event,
       EXTRACT(EPOCH FROM (clock_timestamp()-query_start))*1000 AS query_ms,
       EXTRACT(EPOCH FROM (clock_timestamp()-xact_start))*1000 AS transaction_ms,
       pg_blocking_pids(pid) AS blockers,
       CASE WHEN query ILIKE '%pg_advisory_xact_lock%' THEN 'advisory'
            WHEN query ILIKE '%display_snapshot%' THEN 'display_snapshot'
            WHEN query ILIKE '%indicator%' THEN 'indicator'
            WHEN query ILIKE '%native_history_loads%' THEN 'native_history'
            WHEN query ILIKE '%provider_%' THEN 'provider'
            WHEN query ILIKE '%market_demand%' THEN 'market_demand'
            WHEN query ILIKE '%composite_%' THEN 'composite'
            WHEN query ILIKE '%history_artifact%' THEN 'history_artifact'
            ELSE 'other' END AS query_class
FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid()
  AND (state='active' OR state='idle in transaction' OR wait_event_type='Lock')
""")
locks=text("""
SELECT pid,locktype,mode,granted,objid::bigint AS key
FROM pg_locks
WHERE locktype='advisory' AND objid IN (8675313,8675310)
""")
tasks=text("""
SELECT id,request_id,state,created_at,lease_until,generation,pages,stalls,
       query_json->>'instrument' AS instrument,
       query_json->>'timeframe' AS timeframe,
       query_json->>'firstDataRequest' AS first
FROM native_history_loads
WHERE created_at>=:since
ORDER BY created_at DESC LIMIT 50
""")
with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as connection:
    connection.exec_driver_sql('SET default_transaction_read_only=on')
    connection.exec_driver_sql("SET statement_timeout='1500ms'")
    while time.time()-start<160:
        tick=time.monotonic()
        try:
            a=[dict(r) for r in connection.execute(activity).mappings()]
            b=[dict(r) for r in connection.execute(locks).mappings()]
            c=[dict(r) for r in connection.execute(tasks,{'since':int(start*1000)-5000}).mappings()]
            print(json.dumps({'at':int(time.time()*1000),'activity':a,'locks':b,'tasks':c},default=float),flush=True)
        except Exception as error:
            print(json.dumps({'at':int(time.time()*1000),'error_type':type(error).__name__}),flush=True)
        time.sleep(max(0,0.5-(time.monotonic()-tick)))
