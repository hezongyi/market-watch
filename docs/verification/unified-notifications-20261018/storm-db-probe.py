import json
from sqlalchemy import func,select,text
from alerts import notification_center as center
from alerts.storage import NoticeEvent,NoticeIncident,Outbox,transaction
with transaction() as db:
 assert db.scalar(text('select current_database()'))=='preview_mw75_final'
 rows=list(db.scalars(select(NoticeEvent).where(NoticeEvent.source_id.startswith('1b459297-af39-4cfa-9359-ce05beb1e3f0:'))))
 result={'database':'preview_mw75_final','synthetic_only':True,'events':len(rows),'unique_sources':len({r.source_id for r in rows}),'critical':sum(r.severity=='critical' for r in rows),'all_incidents_once':all(db.get(NoticeIncident,r.incident_id).count==1 for r in rows),'health':center.health(db),'database_bytes':db.scalar(text('select pg_database_size(current_database())')),'outbox_count':db.scalar(select(func.count()).select_from(Outbox))}
 assert result['events']==124 and result['unique_sources']==124 and result['critical']==1 and result['all_incidents_once'] and result['health']['pending_sources']==0
 print(json.dumps(result))
