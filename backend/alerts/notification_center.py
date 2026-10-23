"""Professional-chart events. Reliable intake, commit-ordered projection and recovery.

Every publisher locks the same subject stream until commit. Source transactions only
append Audit facts; this module never evaluates alerts or sends phone requests.
"""
import base64
import hashlib
import hmac
import json
import math
import secrets
import uuid

from fastapi import HTTPException
from sqlalchemy import BigInteger, String, and_, cast, delete, exists, func, or_, select

from .chart_alert_message import condition_label
from .market_names import code_search
from .notice_instruments import capture, enrich, search_clause
from .notification_sources import safe_text
from .storage import (
    Audit,
    ChartAlert,
    ChartAlertVersion,
    DeliveryAttempt,
    DeviceReceipt,
    NoticeChange,
    NoticeEvent,
    NoticeIncident,
    NoticeIntake,
    NoticeIntakeBudget,
    NoticeObservation,
    NoticeSourceReceipt,
    NoticeStream,
    Notification,
    Preference,
    SignalRow,
    now_ms,
)

SUBJECT = 'admin'  # The existing application has exactly one authenticated principal.
LEVELS = {'info': 0, 'warning': 1, 'error': 2, 'critical': 3}
CONTEXT_KEYS = {'workspace_id', 'chart_index', 'instrument', 'timeframe', 'series_kind',
                'provider', 'epoch', 'generation', 'attempt_id', 'code', 'consumer',
                'input_fingerprint', 'params_fingerprint', 'algorithm_version',
                'snapshot_id', 'source_id', 'dataset_id', 'task_id', 'revision',
                'visible_from', 'visible_to', 'endpoint', 'acceptance_run'}
BROWSER_SOURCES = {'workspace', 'indicator', 'history', 'capacity', 'data_center',
                   'preferences', 'market', 'connection', 'chart_shell'}
OBSERVATIONS = {'received', 'rendered', 'viewed', 'handled', 'sound_blocked',
                'sound_suppressed', 'sound_expired', 'sound_reserved', 'sound_started',
                'sound_failed', 'sound_unknown', 'sound_manual'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def intent_hash(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def clean(value, depth=0):
    """Bounded plain evidence. No credentials, active HTML or unbounded market arrays."""
    if depth > 6:
        return '[深层证据请查原始记录]'
    if isinstance(value, dict):
        return {str(k)[:100]: clean(v, depth + 1) for k, v in list(value.items())[:100]
                if not any(word in str(k).lower() for word in
                           ('password', 'secret', 'authorization', 'cookie', 'csrf', 'token'))}
    if isinstance(value, list):
        return [clean(v, depth + 1) for v in value[:30]]
    if isinstance(value, str):
        return safe_text(value, 2000)
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return safe_text(value)


def _insert_once(db, model, values, key):
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    insert = pg_insert if db.bind.dialect.name == 'postgresql' else sqlite_insert
    return db.execute(insert(model).values(**values).on_conflict_do_nothing(index_elements=key))


def stream(db, subject=SUBJECT, *, lock=False):
    if not db.get(NoticeStream, subject):
        _insert_once(db, NoticeStream, {'subject': subject, 'epoch': str(uuid.uuid4()), 'seq': 0,
            'floor': 0, 'started_at': now_ms(), 'cursor_secret': secrets.token_hex(32)}, ['subject'])
    query = select(NoticeStream).where(NoticeStream.subject == subject)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return db.scalar(query)


def _cursor(state, payload):
    raw = canonical({'epoch': state.epoch, **payload}).encode()
    sign = hmac.new(state.cursor_secret.encode(), raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw + sign).decode().rstrip('=')


def _decode(state, token, kind):
    try:
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        body, sign = raw[:-32], raw[-32:]
        if not hmac.compare_digest(sign, hmac.new(state.cursor_secret.encode(), body, hashlib.sha256).digest()):
            raise ValueError()
        value = json.loads(body)
        if value['kind'] != kind:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, '无效通知游标') from None
    if value.get('epoch') != state.epoch:
        raise reset(state, '通知日志已换代，请重新加载')
    return value


def reset(state, reason):
    return HTTPException(409, {'code': 'NOTICE_RESET', 'message': reason,
        'epoch': state.epoch, 'floor': state.floor, 'highwater': state.seq})


def incident_dict(row):
    return {'id': row.id, 'first_at': row.first_at, 'last_at': row.last_at,
            'closed_at': row.closed_at, 'count': row.count,
            'count_scope': '当前事故已接受发生数', 'severity_rank': row.severity}


def summary(db, row, *, incidents=None):
    group = incidents.get(row.incident_id) if incidents is not None else db.get(NoticeIncident, row.incident_id)
    return {'id': row.id, 'source_domain': row.source_domain, 'source_kind': row.source_kind,
        'source_id': row.source_id, 'incident_id': row.incident_id, 'occurred_at': row.occurred_at,
        'recorded_at': row.recorded_at, 'version': row.version, 'first_seq': row.first_seq,
        'severity': row.severity, 'kind': row.kind, 'workspace': row.workspace,
        'instrument': row.instrument, 'viewed_at': row.viewed_at, 'handled_at': row.handled_at,
        'attention': row.attention, 'backfill': row.backfill, **row.body,
        'incident': incident_dict(group) if group else None}


def publish(db, state, kind, event_id, body):
    state.seq += 1
    db.add(NoticeChange(subject=state.subject, seq=state.seq, event_id=event_id,
                        at=now_ms(), kind=kind, body=body))
    return state.seq


def _new_event(db, state, *, ident, source_kind, source_id, occurred_at, body,
               severity='error', kind='failure', dedupe=None, backfill=False, intake=None,
               source_version=0, accepted_at=None):
    existing = db.get(NoticeEvent, ident)
    if existing:
        return existing
    dedupe = intent_hash([state.subject, source_kind, dedupe or ident])
    incident = db.scalar(select(NoticeIncident).where(NoticeIncident.subject == state.subject,
        NoticeIncident.dedupe_key == dedupe, NoticeIncident.closed_at.is_(None)))
    attention = incident is None or LEVELS[severity] > incident.severity
    if incident is None:
        incident = NoticeIncident(id=str(uuid.uuid4()), subject=state.subject, dedupe_key=dedupe,
            first_at=occurred_at, last_at=occurred_at, count=0, severity=0, source_version=0,
            last_event_id='')
        db.add(incident)
    incident.first_at = min(incident.first_at, occurred_at)
    incident.last_at = max(incident.last_at, occurred_at)
    incident.count += 1
    incident.severity = max(incident.severity, LEVELS[severity])
    incident.source_version = max(incident.source_version, source_version)
    incident.last_event_id = ident
    body = {**body, 'accepted_at': accepted_at if accepted_at is not None else occurred_at}
    context = body.get('context', {})
    event = NoticeEvent(id=ident, subject=state.subject, source_domain='pro_chart',
        source_kind=source_kind, source_id=source_id, incident_id=incident.id,
        occurred_at=occurred_at, recorded_at=now_ms(), first_seq=state.seq + 1,
        version=state.seq + 1, severity=severity, kind=kind,
        workspace=str(context.get('workspace_id') or '')[:80],
        instrument=str(context.get('instrument') or '')[:120],
        attention=attention and body.get('notify_web', True) and not backfill,
        backfill=backfill, body=clean(body), intake_hash=intake)
    db.add(event)
    db.flush()
    publish(db, state, 'created', ident, summary(db, event))
    return event


def signal_event_id(signal_id):
    return 's:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'market-watch:chart-signal:' + signal_id))


def _signal(db, state, ident, at):
    signal = db.get(SignalRow, ident)
    if not signal or not signal.chart_alert_id:
        return None  # Legacy watch/unknown records never enter active intake.
    version = db.scalar(select(ChartAlertVersion).where(
        ChartAlertVersion.alert_id == signal.chart_alert_id,
        ChartAlertVersion.version == signal.evidence.get('rule_version')))
    if not version:
        return None
    config, evidence = version.config, signal.evidence
    association = config.get('association') or {}
    return _new_event(db, state, ident=signal_event_id(ident), source_kind='chart_alert',
        source_id=ident, occurred_at=signal.occurred_at, severity='warning', kind='alert',
        backfill=at < state.started_at, accepted_at=evidence.get('detected_at', at), body={'title': signal.reason,
            'message': condition_label(config['condition']),
            'notify_web': config.get('notify_web', True) and not (evidence.get('late') and config.get('late_delivery', 'log_only') == 'log_only'),
            'notify_ntfy': config.get('notify_ntfy', False),
            'late_delivery': config.get('late_delivery'),
            'context': {**association, 'instrument': signal.instrument_id,
                        'timeframe': config.get('timeframe'), 'series_kind': config.get('series_kind')},
            'evidence': {key: evidence.get(key) for key in ('left', 'right', 'price', 'threshold',
                'unit', 'rule_version', 'run', 'ordinal', 'observation_id', 'detected_at', 'late')},
            'evidence_ref': {'signal_id': ident, 'rule_version_id': version.id},
            'channels': {}, 'channel_versions': {}})


def _server_source(db, state, audit):
    source = audit.details
    kind, facts = source['kind'], source['facts']
    if kind == 'signal':
        row = _signal(db, state, facts['signal_id'], audit.at)
        return row.id if row else None
    if kind.startswith('phone_'):
        signal = db.get(SignalRow, facts['signal_id'])
        if (signal and signal.created_at < now_ms() - 30 * 86400_000
                and not db.get(NoticeEvent, signal_event_id(signal.id))):
            return None  # A late phone fact cannot recreate an expired event.
        row = _signal(db, state, facts['signal_id'], audit.at)
        if not row:
            return None
        observation_id = ('phone-attempt:' + source['source_id'] if kind == 'phone_attempt' else
            'phone-received:' + source['source_id'] if kind == 'phone_received' else 'source:' + str(audit.id))
        if not db.get(NoticeObservation, observation_id):
            db.add(NoticeObservation(id=observation_id, event_id=row.id, subject=state.subject,
                profile='server', kind=kind, at=facts.get('at', facts.get('received_at', audit.at)), reported_at=None,
                details=clean(facts), intent_hash=intent_hash(facts)))
        body = {**row.body}
        channels, versions = dict(body.get('channels', {})), dict(body.get('channel_versions', {}))
        # Each Notification update holds its source row lock before its Audit insert.
        # Its audit ID is a per-source version, never a global consumption cursor.
        version_key = kind + ':' + (str(facts.get('device_id')) if kind == 'phone_received' else '')
        version = int(source['source_id']) if kind in ('phone_attempt', 'phone_received') else audit.id
        if version > versions.get(version_key, 0):
            channels[version_key] = clean(facts)
            versions[version_key] = version
        body.update(channels=channels, channel_versions=versions)
        row.body, row.version = body, state.seq + 1
        db.flush()
        publish(db, state, 'updated', row.id, summary(db, row))
        return row.id
    if kind == 'task_failure':
        ident = 't:' + str(uuid.uuid5(uuid.NAMESPACE_URL, canonical([
            source['source_id'], audit.id, facts['attempt'], facts['code']])))
        row = _new_event(db, state, ident=ident, source_kind=facts.get('source_kind', 'data_center'),
            source_id=source['source_id'], occurred_at=audit.at, source_version=audit.id,
            dedupe=facts['dedupe_key'], backfill=audit.at < state.started_at,
            body={'title': facts['title'], 'message': facts['code'], 'notify_web': facts.get('notify_web', True),
                  'context': facts.get('context', {}), 'evidence': facts.get('evidence', {}),
                  'instrument_display': facts.get('instrument_display')})
        return row.id
    if kind in ('recovery', 'observation_end'):
        dedupe = intent_hash([state.subject, facts.get('source_kind', 'data_center'), facts['dedupe_key']])
        group = db.scalar(select(NoticeIncident).where(NoticeIncident.subject == state.subject,
            NoticeIncident.dedupe_key == dedupe, NoticeIncident.closed_at.is_(None)))
        if group and audit.id > group.source_version and kind == 'recovery':
            group.closed_at = audit.at
            publish(db, state, 'incident', '', incident_dict(group))
        elif group and kind == 'observation_end':
            row = db.get(NoticeEvent, group.last_event_id)
            if row:
                row.body = {**row.body, 'observation_status': 'ended', 'observation_ended_at': audit.at}
                row.version = state.seq + 1
                publish(db, state, 'updated', row.id, summary(db, row))
        return None
    raise ValueError('Unsupported reliable notice source')


def project(db, *, limit=100, fail_after=None):
    state = stream(db, lock=True)
    audit_key = 'audit:' + cast(Audit.id, String)
    sources = list(db.scalars(select(Audit).where(Audit.kind == 'notice_source',
        ~exists(select(NoticeSourceReceipt.source_key).where(
            NoticeSourceReceipt.source_key == audit_key))).order_by(Audit.id).limit(max(1, limit // 2))))
    count = 0
    for audit in sources:
        event_id = _server_source(db, state, audit)
        db.add(NoticeSourceReceipt(source_key='audit:' + str(audit.id), event_id=event_id))
        count += 1
        if fail_after == count:
            raise RuntimeError('Injected projection crash')
    intakes = list(db.scalars(select(NoticeIntake).where(NoticeIntake.subject == state.subject,
        ~exists(select(NoticeSourceReceipt.source_key).where(
            NoticeSourceReceipt.source_key == 'browser:' + NoticeIntake.id)))
        .order_by(func.coalesce(cast(NoticeIntake.body['_accepted_order'].as_string(), BigInteger),
            NoticeIntake.at * 1000), NoticeIntake.id).limit(limit - count)))
    for intake in intakes:
        value = intake.body
        event_id = intake.id
        if value.get('_server_task'):
            # Old loaded bundles still report per listener after a deployment.
            # The fenced worker is authoritative; retain this receipt without
            # another occurrence or allowing a browser to assert its recovery.
            event_id = None
        elif value.get('recovery_of'):
            prior = db.get(NoticeEvent, value['recovery_of'])
            group = db.get(NoticeIncident, prior.incident_id) if prior else None
            if (prior and prior.subject == state.subject and prior.source_kind == value['source_kind']
                    and prior.body.get('profile') == intake.profile
                    and prior.body.get('context') == value.get('context')
                    and group.last_event_id == prior.id and not group.closed_at):
                if value.get('observation_ended'):
                    prior.body = {**prior.body, 'observation_status': 'ended', 'observation_ended_at': intake.at}
                    prior.version = state.seq + 1
                    publish(db, state, 'updated', prior.id, summary(db, prior))
                else:
                    group.closed_at = intake.at
                    publish(db, state, 'incident', '', incident_dict(group))
        else:
            _new_event(db, state, ident=intake.id, source_kind=value['source_kind'],
                source_id=value['attempt_id'], occurred_at=value['occurred_at'],
                dedupe=[intake.profile, value['source_kind'], value['code'], value.get('dedupe_context', {})],
                severity=value['severity'], backfill=intake.at < state.started_at, accepted_at=intake.at,
                intake=intake.intent_hash, body={'title': value['title'], 'message': value['message'],
                    'context': value['context'], 'evidence': value['evidence'],
                    'notify_web': True, 'client_reported_time': True,
                    'profile': intake.profile, 'code': value['code'],
                    'instrument_display': value.get('_instrument_display')})
        db.add(NoticeSourceReceipt(source_key='browser:' + intake.id, event_id=event_id))
        count += 1
        if fail_after == count:
            raise RuntimeError('Injected projection crash')
    db.flush()
    return count


def accept_browser(db, subject, value):
    raw = value.model_dump(mode='json')
    # Preserve the intake signature of clients predating this additive field.
    if not raw.get('observation_ended'):
        raw.pop('observation_ended', None)
    if len(canonical(raw).encode()) > 16 * 1024:
        raise HTTPException(413, '单条通知超过16 KiB，未保存')
    raw['context'] = {k: clean(v) for k, v in raw['context'].items() if k in CONTEXT_KEYS}
    raw['dedupe_context'] = {k: v for k, v in raw['context'].items()
        if k in ('workspace_id', 'chart_index', 'instrument', 'timeframe', 'consumer', 'source_id', 'endpoint', 'acceptance_run')}
    raw = clean(raw)
    signature = intent_hash(raw)
    prior = db.get(NoticeIntake, value.event_id)
    if prior:
        if prior.subject != subject or prior.intent_hash != signature:
            raise HTTPException(409, '通知身份对应不同内容，未覆盖原记录')
        return {'id': prior.id, 'status': 'accepted', 'recorded_at': prior.at}
    from .market_notices import legacy_shared_task
    shared_task = legacy_shared_task(db, raw)
    if shared_task:
        raw['_server_task'] = shared_task
    _insert_once(db, NoticeIntakeBudget, {'subject': subject, 'at': now_ms(), 'tokens': 120}, ['subject'])
    budget = db.scalar(select(NoticeIntakeBudget).where(
        NoticeIntakeBudget.subject == subject).with_for_update().execution_options(populate_existing=True))
    # Recheck after locking: concurrent delivery of the same ID costs no tokens.
    prior = db.get(NoticeIntake, value.event_id, populate_existing=True)
    if prior:
        if prior.subject != subject or prior.intent_hash != signature:
            raise HTTPException(409, '通知身份冲突')
        return {'id': prior.id, 'status': 'accepted', 'recorded_at': prior.at}
    at = now_ms()
    budget.tokens = min(120, budget.tokens + max(0, at - budget.at) / 1000)
    budget.at = at
    if budget.tokens < 1:
        raise HTTPException(429, '通知接收限流，本机待同步记录仍需保留', headers={'Retry-After': '1'})
    budget.tokens -= 1
    # The existing subject budget lock also orders durable acceptance. A
    # timestamp alone cannot order same-millisecond failure/recovery/recurrence.
    # Keep the logical order separate from the actual recorded/report times.
    order_key = 'notice_intake_order:' + subject
    previous_order = db.get(Preference, order_key, populate_existing=True)
    order = max(at * 1000 + 1, (previous_order.value['last'] if previous_order else 0) + 1)
    raw['_instrument_display'] = capture(db, raw)
    raw['_accepted_order'] = order
    if previous_order:
        previous_order.value = {'last': order}
    else:
        db.add(Preference(key=order_key, value={'last': order}))
    db.add(NoticeIntake(id=value.event_id, subject=subject, profile=value.profile, at=at,
                       intent_hash=signature, body=raw))
    return {'id': value.event_id, 'status': 'accepted', 'recorded_at': at}


def event_for(db, subject, ident):
    row = db.get(NoticeEvent, ident)
    if not row or row.subject != subject:
        raise HTTPException(404, '通知不可用或尚待投影')
    return row


def observe(db, subject, value):
    state = stream(db, subject, lock=True)
    row = event_for(db, subject, value.event_id)
    raw = clean(value.model_dump(mode='json'))
    signature = intent_hash(raw)
    prior = db.get(NoticeObservation, value.observation_id)
    if prior:
        if prior.subject != subject or prior.intent_hash != signature:
            raise HTTPException(409, '观察身份冲突，未覆盖原事实')
        return {'ok': True, 'duplicate': True}
    db.add(NoticeObservation(id=value.observation_id, subject=subject, event_id=row.id,
        profile=value.profile, kind=value.kind, reported_at=value.reported_at,
        details=raw['details'], intent_hash=signature))
    if value.kind == 'viewed' and not row.viewed_at:
        row.viewed_at = now_ms()
    if value.kind == 'handled' and not row.handled_at:
        row.handled_at = now_ms()
    row.version = state.seq + 1
    db.flush()
    publish(db, state, 'updated', row.id, summary(db, row))
    return {'ok': True, 'duplicate': False}


def list_events(db, subject, filters, *, before=None, limit=100):
    state = stream(db, subject)
    # Keep default-order cursor fingerprints compatible with existing clients.
    filters = {key: value for key, value in filters.items() if key != 'sort' or value != 'newest'}
    oldest = filters.get('sort') == 'oldest'
    fingerprint = intent_hash({'subject': subject, **filters})
    high, anchor = state.seq, None
    if before:
        cursor = _decode(state, before, 'history')
        if cursor['query'] != fingerprint:
            raise HTTPException(400, '筛选已变化，请重新加载通知')
        high, anchor = cursor['high'], cursor['anchor']
    clauses = [NoticeEvent.subject == subject, NoticeEvent.source_domain == 'pro_chart', NoticeEvent.first_seq <= high]
    if filters.get('audience') == 'system':
        clauses.append(NoticeEvent.source_kind != 'chart_alert')
    if filters.get('incident'):
        clauses.append(NoticeEvent.incident_id == filters['incident'])
    if filters.get('audience') == 'system' and filters.get('grouped', True):
        # One row per incident; all accepted occurrences remain available as evidence.
        latest = select(func.max(NoticeEvent.first_seq)).where(
            NoticeEvent.subject == subject, NoticeEvent.source_domain == 'pro_chart',
            NoticeEvent.source_kind != 'chart_alert', NoticeEvent.first_seq <= high,
        ).group_by(NoticeEvent.incident_id)
        clauses.append(NoticeEvent.first_seq.in_(latest))
    elif filters.get('audience') == 'alerts':
        clauses.append(NoticeEvent.source_kind == 'chart_alert')
    for key, column in [('severity', NoticeEvent.severity), ('kind', NoticeEvent.kind),
                        ('source', NoticeEvent.source_kind), ('workspace', NoticeEvent.workspace),
                        ('instrument', NoticeEvent.instrument)]:
        if filters.get(key):
            clauses.append(column == filters[key])
    if filters.get('state') == 'unread':
        clauses.append(NoticeEvent.incident_id.in_(unread_system_incidents(subject))
                       if filters.get('audience') == 'system' and filters.get('grouped', True)
                       else NoticeEvent.viewed_at.is_(None))
    if filters.get('state') == 'unhandled':
        clauses.append(NoticeEvent.handled_at.is_(None))
    if filters.get('state') == 'handled':
        clauses.append(NoticeEvent.handled_at.is_not(None))
    if filters.get('since') is not None:
        clauses.append(NoticeEvent.occurred_at >= filters['since'])
    if filters.get('until') is not None:
        clauses.append(NoticeEvent.occurred_at < filters['until'])
    if filters.get('q'):
        # Literal substring search; wildcard characters have no special meaning.
        # JSON text may contain escaped Unicode. Search decoded user-facing values too.
        searchable = [NoticeEvent.body[key].as_string() for key in ('title', 'message', 'code')]
        searchable.extend([NoticeEvent.instrument, NoticeEvent.workspace, cast(NoticeEvent.body, String)])
        clauses.append(or_(code_search(filters['q'], *searchable), search_clause(NoticeEvent, filters['q'], subject=subject)))
    if anchor:
        next_time = NoticeEvent.occurred_at > anchor[0] if oldest else NoticeEvent.occurred_at < anchor[0]
        next_id = NoticeEvent.id > anchor[1] if oldest else NoticeEvent.id < anchor[1]
        clauses.append(or_(next_time, and_(NoticeEvent.occurred_at == anchor[0], next_id)))
    rows = list(db.scalars(select(NoticeEvent).where(*clauses)
        .order_by(NoticeEvent.occurred_at.asc() if oldest else NoticeEvent.occurred_at.desc(),
                  NoticeEvent.id.asc() if oldest else NoticeEvent.id.desc()).limit(limit + 1)))
    page = rows[:limit]
    next_cursor = _cursor(state, {'kind': 'history', 'query': fingerprint, 'high': high,
        'anchor': [page[-1].occurred_at, page[-1].id]}) if len(rows) > limit else None
    unread = db.scalar(select(func.count()).select_from(NoticeEvent).where(
        NoticeEvent.subject == subject, NoticeEvent.source_domain == 'pro_chart', NoticeEvent.viewed_at.is_(None)))
    incidents = {group.id: group for group in db.scalars(select(NoticeIncident).where(
        NoticeIncident.subject == subject,
        NoticeIncident.id.in_({row.incident_id for row in page}))) } if page else {}
    events = enrich(db, [summary(db, row, incidents=incidents) for row in page], subject=subject)
    if filters.get('audience') == 'system' and filters.get('grouped', True):
        unread_groups = set(db.scalars(unread_system_incidents(subject).where(
            NoticeEvent.incident_id.in_([event['incident_id'] for event in events]))))
        for event in events:
            if event['incident_id'] in unread_groups:
                event['viewed_at'] = None
    return {'events': events, 'before': next_cursor,
        'epoch': state.epoch, 'highwater': high, 'after': _cursor(state, {'kind': 'changes', 'seq': high}),
        'unread': unread, 'system_unread': system_unread(db, subject),
        'server_time': now_ms(), 'retention_days': 30}


def unread_system_incidents(subject):
    return select(NoticeEvent.incident_id).where(
        NoticeEvent.subject == subject, NoticeEvent.source_domain == 'pro_chart',
        NoticeEvent.source_kind != 'chart_alert', NoticeEvent.viewed_at.is_(None)).distinct()


def system_unread(db, subject):
    return db.scalar(select(func.count()).select_from(unread_system_incidents(subject).subquery()))


def read_system(db, subject, value):
    """Bounded, explicit reading of system records; never acknowledges a phone alert."""
    state = stream(db, subject, lock=True)
    if value.epoch != state.epoch:
        raise reset(state, '通知日志已重建，请重新打开列表后标为已读')
    through = min(value.through, state.seq)
    clauses = [NoticeEvent.subject == subject, NoticeEvent.source_domain == 'pro_chart',
               NoticeEvent.source_kind != 'chart_alert', NoticeEvent.first_seq <= through,
               NoticeEvent.viewed_at.is_(None)]
    if value.incident_id:
        clauses.append(NoticeEvent.incident_id == value.incident_id)
    rows = list(db.scalars(select(NoticeEvent).where(*clauses)
                          .order_by(NoticeEvent.first_seq).limit(100)))
    at = now_ms()
    for row in rows:
        row.viewed_at = at
        row.version = state.seq + 1
        db.add(NoticeObservation(id=str(uuid.uuid4()), subject=subject, event_id=row.id,
            profile=value.profile, kind='viewed', reported_at=at,
            details={'operation': 'explicit_system_read'}, intent_hash=intent_hash([row.id, at])))
        db.flush()
        publish(db, state, 'updated', row.id, summary(db, row))
    db.flush()
    return {'read': len(rows), 'more': bool(db.scalar(select(exists().where(*clauses)))),
            'system_unread': system_unread(db, subject)}


def changes(db, subject, after, *, limit=100):
    state = stream(db, subject)
    cursor = _decode(state, after, 'changes')
    seq = cursor.get('seq')
    if not isinstance(seq, int) or seq < state.floor or seq > state.seq:
        raise reset(state, '通知增量记录已过期或不连续，请重建列表')
    rows = list(db.scalars(select(NoticeChange).where(NoticeChange.subject == subject,
        NoticeChange.seq > seq, NoticeChange.seq <= state.seq).order_by(NoticeChange.seq).limit(limit)))
    last = rows[-1].seq if rows else seq
    bodies = iter(enrich(db, [r.body for r in rows if r.kind in ('created', 'updated')], subject=subject))
    return {'changes': [{'seq': r.seq, 'kind': r.kind, 'event_id': r.event_id,
        'body': next(bodies) if r.kind in ('created', 'updated') else r.body} for r in rows],
        'after': _cursor(state, {'kind': 'changes', 'seq': last}), 'epoch': state.epoch,
        'highwater': state.seq, 'more': last < state.seq, 'server_time': now_ms(),
        'system_unread': system_unread(db, subject),
        'unread': db.scalar(select(func.count()).select_from(NoticeEvent).where(
            NoticeEvent.subject == subject, NoticeEvent.viewed_at.is_(None)))}


def detail(db, subject, ident):
    intake = db.get(NoticeIntake, ident) if ident.startswith('b:') else None
    if (intake and intake.subject == subject and intake.body.get('_server_task')
            and db.get(NoticeSourceReceipt, 'browser:' + ident)):
        # Old clients use this GET solely to acknowledge durable projection.
        # No synthetic history row is needed to retire their local pending item.
        return {'id': ident, 'projection_status': 'shared_source',
                'task_id': intake.body['_server_task']}
    row = event_for(db, subject, ident)
    result = enrich(db, [summary(db, row)], subject=subject)[0]
    reference = row.body.get('evidence_ref', {})
    if reference.get('signal_id'):
        signal = db.get(SignalRow, reference['signal_id'])
        if signal and signal.chart_alert_id:
            result['original_evidence'] = clean(signal.evidence)
            note = db.scalar(select(Notification).where(Notification.signal_id == signal.id))
            result['notification_id'] = note.id if note else None
        else:
            result['evidence_status'] = '原始证据不可用'
    return result


def timeline(db, subject, ident, *, before=None, limit=100):
    event_for(db, subject, ident)
    state = stream(db, subject)
    query = select(NoticeObservation).where(NoticeObservation.subject == subject, NoticeObservation.event_id == ident)
    if before:
        cursor = _decode(state, before, 'timeline')
        if cursor.get('event') != ident:
            raise HTTPException(400, '时间线游标不匹配')
        at, key = cursor['anchor']
        query = query.where(or_(NoticeObservation.at < at, and_(NoticeObservation.at == at, NoticeObservation.id < key)))
    rows = list(db.scalars(query.order_by(NoticeObservation.at.desc(), NoticeObservation.id.desc()).limit(limit + 1)))
    page = rows[:limit]
    return {'event_id': ident, 'observations': [{'id': r.id, 'kind': r.kind, 'profile': r.profile,
        'reported_at': r.reported_at, 'received_at': r.at, 'details': r.details} for r in page],
        'before': _cursor(state, {'kind': 'timeline', 'event': ident,
            'anchor': [page[-1].at, page[-1].id]}) if len(rows) > limit else None}


def retain(db, *, at=None, limit=100):
    at = now_ms() if at is None else at
    state = stream(db, lock=True)
    expired = list(db.scalars(select(NoticeEvent).where(NoticeEvent.subject == state.subject,
        NoticeEvent.recorded_at < at - 30 * 86400_000).limit(limit)))
    for row in expired:
        publish(db, state, 'deleted', row.id, {'id': row.id})
        db.execute(delete(NoticeObservation).where(NoticeObservation.event_id == row.id))
        db.delete(row)
    cutoff = db.scalar(select(func.max(NoticeChange.seq)).where(NoticeChange.subject == state.subject,
        NoticeChange.at < at - 7 * 86400_000))
    if cutoff:
        state.floor = max(state.floor, cutoff)
        db.execute(delete(NoticeChange).where(NoticeChange.subject == state.subject, NoticeChange.seq <= cutoff))
    # Only delete a committed source together with its receipt after its event's
    # retention window. Unprocessed sources can never be selected by this join.
    cutoff_at = at - 31 * 86400_000
    receipts = list(db.scalars(select(NoticeSourceReceipt).where(
        NoticeSourceReceipt.at < cutoff_at,
        ~exists(select(NoticeEvent.id).where(NoticeEvent.id == NoticeSourceReceipt.event_id)))
        .limit(limit)))
    for receipt in receipts:
        if receipt.source_key.startswith('audit:'):
            db.execute(delete(Audit).where(Audit.id == int(receipt.source_key[6:]), Audit.kind == 'notice_source'))
        elif receipt.source_key.startswith('browser:'):
            db.execute(delete(NoticeIntake).where(NoticeIntake.id == receipt.source_key[8:]))
        db.delete(receipt)
    db.execute(delete(NoticeIncident).where(NoticeIncident.subject == state.subject,
        NoticeIncident.last_at < cutoff_at,
        ~exists(select(NoticeEvent.id).where(NoticeEvent.incident_id == NoticeIncident.id))))
    return len(expired)


def rebuild(db):
    """Rebuild summaries in-place from retained sources without alert/phone work.

    Existing immutable IDs, observations and event bodies are retained. Replay only
    fills missing events/channel facts; a new epoch fences every old cursor. The
    historical replay is presentation-inert, including sources newer than startup.
    """
    state = stream(db, lock=True)
    state.epoch = str(uuid.uuid4())
    state.started_at = now_ms() + 1
    state.seq = 0
    state.floor = 0
    db.execute(delete(NoticeChange).where(NoticeChange.subject == state.subject))
    # Keep receipts for expired events: replay must not undo retention tombstones.
    db.execute(delete(NoticeSourceReceipt).where(exists(select(NoticeEvent.id).where(
        NoticeEvent.id == NoticeSourceReceipt.event_id))))
    for row in db.scalars(select(NoticeEvent).where(NoticeEvent.subject == state.subject)):
        row.attention = False
        row.backfill = True
        row.first_seq = 0
        row.version = 0
    db.flush()



def health(db):
    pref = db.get(Preference, 'notice_projector_health')
    audits = select(Audit.at).where(Audit.kind == 'notice_source', ~exists(
        select(NoticeSourceReceipt.source_key).where(NoticeSourceReceipt.source_key == 'audit:' + cast(Audit.id, String))))
    intakes = select(NoticeIntake.at).where(NoticeIntake.subject == SUBJECT, ~exists(
        select(NoticeSourceReceipt.source_key).where(NoticeSourceReceipt.source_key == 'browser:' + NoticeIntake.id)))
    backlog = audits.union_all(intakes).subquery()
    count, oldest = db.execute(select(func.count(), func.min(backlog.c.at))).one()
    return {**(pref.value if pref else {'state': 'unknown', 'message': '尚未观察到通知投影 worker'}),
        'pending_sources': count, 'oldest_pending_at': oldest}


def resolve_signal(db, ident):
    signal = db.get(SignalRow, ident)
    if not signal:
        raise HTTPException(404, '原信号已不可用')
    alert = db.get(ChartAlert, signal.chart_alert_id) if signal.chart_alert_id else None
    version = db.scalar(select(ChartAlertVersion).where(ChartAlertVersion.alert_id == signal.chart_alert_id,
        ChartAlertVersion.version == signal.evidence.get('rule_version'))) if alert else None
    if not version:
        return {'domain': 'legacy_watch' if signal.watch_id else 'legacy_unknown', 'destination': None}
    workspace = (version.config.get('association') or {}).get('workspace_id')
    from urllib.parse import quote
    return {'domain': 'pro_chart', 'event_id': signal_event_id(ident), 'destination': '/advanced-charts/' + quote(workspace or '', safe='') +
        '?panel=alerts&signal=' + quote(ident, safe='')}


def backfill(db, *, limit=100):
    """Import chart facts without a reliable source, including application rollback writes."""
    state = stream(db, lock=True)
    rows = list(db.scalars(select(SignalRow).where(SignalRow.chart_alert_id.is_not(None),
        SignalRow.created_at >= now_ms() - 30 * 86400_000,
        ~exists(select(Audit.id).where(Audit.kind == 'notice_source',
            Audit.details['kind'].as_string() == 'signal',
            Audit.details['facts']['signal_id'].as_string() == SignalRow.id)),
        ~exists(select(NoticeEvent.id).where(NoticeEvent.source_id == SignalRow.id, NoticeEvent.source_kind == 'chart_alert')),
        ~exists(select(NoticeSourceReceipt.source_key).where(NoticeSourceReceipt.source_key == 'backfill:' + SignalRow.id)))
        .order_by(SignalRow.occurred_at, SignalRow.id).limit(limit)))
    count = 0
    for signal in rows:
        marker = 'backfill:' + signal.id
        if db.get(NoticeSourceReceipt, marker):
            continue
        row = _signal(db, state, signal.id, state.started_at - 1)
        db.add(NoticeSourceReceipt(source_key=marker, event_id=row.id if row else None))
        if not row:
            continue
        row.backfill, row.attention = True, False
        note = db.scalar(select(Notification).where(Notification.signal_id == signal.id))
        if note:
            channels = {'phone_state:': {'notification_id': note.id, 'status': note.status, 'stopped_at': note.ack_at}}
            row.body = {**row.body, 'channels': channels, 'historical_observations': '未存储的网页与声音事实均未知'}
            for attempt in db.scalars(select(DeliveryAttempt).where(DeliveryAttempt.notification_id == note.id)):
                key = 'phone-attempt:' + str(attempt.id)
                if not db.get(NoticeObservation, key):
                    facts = clean({'at': attempt.at, 'status': attempt.status, 'details': attempt.details})
                    db.add(NoticeObservation(id=key, event_id=row.id, subject=state.subject, profile='server',
                        kind='phone_attempt', at=attempt.at, details=facts, intent_hash=intent_hash(facts)))
            for receipt in db.scalars(select(DeviceReceipt).where(DeviceReceipt.notification_id == note.id)):
                key = 'phone-received:' + str(receipt.id)
                if not db.get(NoticeObservation, key):
                    facts = {'received_at': receipt.received_at, 'device_id': receipt.device_id}
                    db.add(NoticeObservation(id=key, event_id=row.id, subject=state.subject, profile='server',
                        kind='phone_received', at=receipt.received_at, details=facts, intent_hash=intent_hash(facts)))
        row.version = state.seq + 1
        db.flush()
        publish(db, state, 'updated', row.id, summary(db, row))
        count += 1
    return count


def reconcile_channels(db, *, limit=100):
    """Catch up original phone records written while an older binary had no hooks."""
    from .config import settings
    if not settings.notification_center_sources_enabled:
        return 0
    stream(db, lock=True)
    count = 0
    for model, kind, prefix in ((DeliveryAttempt, 'phone_attempt', 'phone-attempt:'),
                                 (DeviceReceipt, 'phone_received', 'phone-received:')):
        rows = db.execute(select(model, Notification).join(Notification,
            model.notification_id == Notification.id).join(NoticeEvent,
            and_(NoticeEvent.source_id == Notification.signal_id, NoticeEvent.source_kind == 'chart_alert'))
            .where(~exists(select(NoticeObservation.id).where(
                NoticeObservation.id == prefix + cast(model.id, String))))
            .order_by(model.id).limit(max(0, limit-count))).all()
        for item, note in rows:
            facts = {'signal_id': note.signal_id, 'notification_id': note.id}
            if kind == 'phone_attempt':
                facts.update(attempt_id=item.id, at=item.at, status=item.status,
                    details={key: safe_text(item.details[key]) for key in
                        ('provider_id', 'status_code', 'error') if key in item.details})
            else:
                facts.update(device_id=item.device_id, received_at=item.received_at)
            db.add(Audit(kind='notice_source', details={'schema_version': 1, 'kind': kind,
                'source_id': str(item.id), 'facts': facts, 'reconciled': True}))
            count += 1
    channel = NoticeEvent.body['channels']['phone_state:']
    notes = db.scalars(select(Notification).join(NoticeEvent,
        and_(NoticeEvent.source_id == Notification.signal_id, NoticeEvent.source_kind == 'chart_alert'))
        .where(or_(channel['status'].as_string().is_distinct_from(Notification.status),
                   cast(channel['stopped_at'].as_string(), BigInteger).is_distinct_from(Notification.ack_at)))
        .order_by(Notification.id).limit(max(0, limit-count))
        .with_for_update(of=Notification).execution_options(populate_existing=True))
    for note in notes:
        db.add(Audit(kind='notice_source', details={'schema_version': 1, 'kind': 'phone_state',
            'source_id': note.id, 'reconciled': True, 'facts': {'signal_id': note.signal_id,
                'notification_id': note.id, 'status': note.status, 'stopped_at': note.ack_at}}))
        count += 1
    # Allocate source versions while holding each phone row lock, so a later
    # real update always obtains a later Audit ID than this snapshot.
    db.flush()
    return count
