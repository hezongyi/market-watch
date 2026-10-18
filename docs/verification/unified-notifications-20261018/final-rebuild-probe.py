import hashlib
import json
import sys

from sqlalchemy import func, select, text
from alerts import notification_center as center
from alerts.config import settings
from alerts.storage import NoticeEvent, NoticeIncident, NoticeObservation, Outbox, transaction

assert settings.database_application_name == 'mw-issue75-v2-20261018'
assert not settings.delivery_enabled
with transaction() as db:
    assert db.scalar(text('select current_database()')) == 'preview_mw75_final'
    events = list(db.scalars(select(NoticeEvent).where(NoticeEvent.id.like('t:%')).order_by(NoticeEvent.id)))
    groups = {e.incident_id: db.get(NoticeIncident, e.incident_id).count for e in events}
    state = center.stream(db)
    result = {
        'stage': sys.argv[1], 'database': 'preview_mw75_final',
        'task_events': len(events), 'unique_sources': len({e.source_id for e in events}),
        'task_ids_sha256': hashlib.sha256('\n'.join(e.id for e in events).encode()).hexdigest(),
        'incident_counts_sha256': hashlib.sha256(json.dumps(groups, sort_keys=True).encode()).hexdigest(),
        'incident_count_sum': sum(groups.values()), 'all_incidents_once': all(v == 1 for v in groups.values()),
        'all_backfill': all(e.backfill and not e.attention for e in events),
        'epoch': state.epoch, 'stream_seq': state.seq,
        'automatic_sound_observations': db.scalar(select(func.count()).select_from(NoticeObservation).where(NoticeObservation.kind.in_(['sound_reserved', 'sound_started']))),
        'outbox_count': db.scalar(select(func.count()).select_from(Outbox)),
        'database_bytes': db.scalar(text('select pg_database_size(current_database())')),
        'health': center.health(db),
    }
    assert len(events) == 1000 and len(groups) == 1000 and result['all_incidents_once']
    assert result['health']['pending_sources'] == 0
print(json.dumps(result, sort_keys=True))
