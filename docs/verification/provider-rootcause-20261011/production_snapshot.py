"""Explicitly read-only DB and sanitized evidence; no secrets in output."""
import json, re
from sqlalchemy import create_engine, text
from alerts.config import settings
from alerts.storage import now_ms

def safe(value):
    return re.sub(r"(?:https?|socks5h?)://\S+", "[URL REDACTED]", str(value))
stamp = now_ms()
queries = {
"instruments": """SELECT i.id,i.source,i.symbol,i.enabled,i.quality,i.last_received,i.error,
EXISTS(SELECT 1 FROM market_datasets d WHERE d.instrument_id=i.id) AS explicit_dataset,
EXISTS(SELECT 1 FROM chart_history_plans p WHERE p.instrument_id=i.id AND p.realtime_enabled) AS realtime_plan,
(SELECT count(*) FROM market_data_demand d WHERE d.instrument_id=i.id AND d.expires>:stamp) AS active_demand,
(SELECT count(*) FROM chart_viewport_demands d WHERE d.instrument_id=i.id AND d.expires>:stamp) AS active_viewport
FROM instruments i WHERE i.id='BTCUSDT' OR i.source='composite' ORDER BY i.id""",
"errors_24h": """SELECT details->>'instrument' AS instrument,details->>'error' AS error,count(*) AS count,
min(at) AS first,max(at) AS last FROM audit_events WHERE kind='market_error' AND at>:since
AND (details->>'instrument'='BTCUSDT' OR details->>'instrument' LIKE 'MC:%')
GROUP BY details->>'instrument', details->>'error' ORDER BY count DESC LIMIT 15""",
"recent_events": """SELECT at,kind,details->>'instrument' AS instrument,details->>'error' AS error,
details->>'minutes' AS minutes FROM audit_events WHERE kind IN ('market_error','market_ingested','market_recovered')
AND (details->>'instrument'='BTCUSDT' OR details->>'instrument'='MC:b3f55bdfc39e3f5c5508371e3:EURUSD')
ORDER BY at DESC LIMIT 20""",
"composites": """SELECT c.id,c.instrument_id,c.dataset_id,c.active_revision_id,r.mapping_id,r.seam,
m.target_dataset_id,i.source AS target_source,i.symbol AS target_symbol,i.enabled AS target_enabled,
i.quality AS target_quality,i.last_received AS target_received,i.error AS target_error
FROM market_composites c LEFT JOIN market_composite_revisions r ON c.active_revision_id=r.id
LEFT JOIN market_realtime_mappings m ON r.mapping_id=m.id
LEFT JOIN market_datasets d ON m.target_dataset_id=d.id LEFT JOIN instruments i ON d.instrument_id=i.id
WHERE c.instrument_id='MC:b3f55bdfc39e3f5c5508371e3:EURUSD'""",
"bars": """SELECT instrument_id,timeframe,max("end") AS latest_end FROM candles
WHERE instrument_id IN ('BTCUSDT','MC:b3f55bdfc39e3f5c5508371e3:EURUSD') AND timeframe='M1'
GROUP BY instrument_id,timeframe""",
"imports": """SELECT instrument_id,status,count(*) AS count FROM import_jobs
WHERE instrument_id='BTCUSDT' OR instrument_id LIKE 'MC:%' GROUP BY instrument_id,status""",
}
result = {"at":stamp, "database_read_only": True}
with create_engine(settings.database_url).connect() as c:
    c.execute(text("SET TRANSACTION READ ONLY"))
    for name, query in queries.items():
        rows = [dict(r) for r in c.execute(text(query),{"stamp":stamp,"since":stamp-86400000}).mappings()]
        for row in rows:
            for key in list(row):
                if "error" in key and row[key] is not None:
                    row[key] = safe(row[key])
        result[name] = rows
print(json.dumps(result,ensure_ascii=False,indent=2))
