"""Shared market outcomes, recorded once in the fenced publication transaction.

Browser transport and subscription registration are separate observations. A
cached price is never proof that a failed supplier read has recovered.
"""
from sqlalchemy import or_, select

from .notification_sources import _append
from .storage import Audit, MarketStreamClient, MarketStreamSubscription, Preference, now_ms


def result_state(payload):
    status = payload.get('status')
    if payload.get('type') == 'error' or payload.get('error') or status == 'error':
        return 'failed'
    if isinstance(status, dict):
        if status.get('error') or status.get('connection_error') or status.get('state') == 'error':
            return 'failed'
    if payload.get('type') == 'quotes':
        rows = payload.get('quotes') or []
        if any(row.get('s') == 'error' or row.get('v', {}).get('fetch_status', 'ok') != 'ok' for row in rows):
            return 'failed'
        return 'healthy' if rows and all(row.get('s') == 'ok' for row in rows) else None
    if payload.get('type') == 'bars':
        if not status or isinstance(status, dict) and (status.get('state') == 'ready' or (
                status.get('connection') == 'connected' and status.get('owned') is True
                and status.get('current_account') is True
                and (status.get('sample_ready') is True or status.get('confirmed_tail_ready') is True))):
            return 'healthy'
    return None


def error_evidence(error, *, provider='', operation='read'):
    """Allowlist exception structure; never return exception text, URLs or args."""
    chain, current = [], error
    for _ in range(6):
        if current is None or id(current) in {id(item) for item in chain}:
            break
        chain.append(current)
        current = current.__cause__ or current.__context__
    names = [type(item).__name__ for item in chain]
    evidence = {'provider': provider, 'operation': operation, 'error_type': names[0] if names else 'Unknown',
                'error_chain': names, 'stage': 'read'}
    if any('timeout' in name.lower() for name in names):
        evidence['stage'] = 'timeout'
    elif any('ssl' in name.lower() or 'tls' in name.lower() for name in names):
        evidence['stage'] = 'tls'
    elif any('proxy' in name.lower() for name in names):
        evidence['stage'] = 'proxy'
    elif any('connect' in name.lower() for name in names):
        evidence['stage'] = 'connect'
    status = getattr(getattr(error, 'response', None), 'status_code', None)
    if isinstance(status, int):
        evidence['http_status'] = status
    return evidence


def state_row(db, task):
    return db.get(Preference, 'notice:market-stream:' + task.id)


def dedupe(task, state):
    return 'market_stream:' + task.id + ':' + str(state.get('observation', 0))


def legacy_shared_task(db, value):
    """Recognize old SSE observers without trusting a browser's task ID.

    Their durable intakes remain evidence/acknowledgeable, but must not create
    listener incidents or recover a source owned by the worker. Snapshot/polling
    errors and tagged acceptance samples retain their independent semantics.
    """
    from .config import settings
    context = value.get('context', {})
    if (not settings.notification_center_sources_enabled or value.get('source_kind') != 'market'
            or value.get('code') != 'MARKET_READ_FAILED' or context.get('acceptance_run')
            or not context.get('source_id') or context.get('generation') is None):
        return None
    subscription = db.scalar(select(MarketStreamSubscription).where(
        MarketStreamSubscription.listener == context['source_id'],
        MarketStreamSubscription.generation == context['generation']).limit(1))
    task_id = (subscription.task_id or subscription.state.get('_notice_task_id')) if subscription else None
    if not task_id:
        return None
    # Existence of a healthy task is not proof that an older queued fault was
    # captured by this worker. Require an actual failure observation at the
    # client's report time. A later upload after cancellation/recovery is fine;
    # if the old generation/evidence is gone, preserve the browser fault.
    source = db.scalar(select(Audit).where(Audit.kind == 'notice_source',
        Audit.details['source_id'].as_string() == task_id,
        Audit.details['kind'].as_string().in_(('task_failure', 'recovery', 'observation_end')),
        Audit.at <= value['occurred_at'],
        or_(Audit.at < value['occurred_at'], Audit.details['kind'].as_string() == 'task_failure'))
        .order_by(Audit.at.desc(), Audit.id.desc()).limit(1))
    return task_id if source and source.details['kind'] == 'task_failure' else None


def record_result(db, task, payload, *, fingerprint):
    from .config import settings
    if not settings.notification_center_sources_enabled:
        return
    outcome = result_state(payload)
    if outcome is None:
        return
    row = state_row(db, task)
    state = dict(row.value) if row else {'open': False, 'observation': 0, 'last_notification_at': 0}
    if state.get('last_fingerprint') == fingerprint:
        return
    state['last_fingerprint'] = fingerprint
    stamp = now_ms()
    if outcome == 'healthy':
        if state['open']:
            _append(db.connection(), 'recovery', task.id, {'source_kind': 'market', 'dedupe_key': dedupe(task, state)})
            state['open'] = False
    else:
        subscriptions = list(db.execute(select(MarketStreamSubscription.listener,
            MarketStreamSubscription.generation, MarketStreamClient.client).join(MarketStreamClient,
                MarketStreamSubscription.client_id == MarketStreamClient.id).where(
                    MarketStreamSubscription.task_id == task.id,
                    MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp)).all())
        evidence = {'task_id': task.id, 'result_epoch': task.result_epoch,
                    'sequence': task.sequence, 'operation': 'shared_' + task.identity.get('kind', 'bars'),
                    'provider': task.identity.get('metadata', {}).get('source', ''),
                    'affected_subscriptions': len(subscriptions),
                    'affected_clients': len({sub.client for sub in subscriptions}),
                    'subscriptions': [dict(listener=sub.listener, generation=sub.generation, client=sub.client)
                                      for sub in subscriptions[:30]],
                    'subscription_sample_limit': 30,
                    'error': payload.get('error_evidence') or {'error_type': 'UpstreamUnavailable', 'stage': 'read'}}
        quote_errors = [quote.get('v', {}).get('error_evidence') for quote in payload.get('quotes', [])
                        if quote.get('v', {}).get('error_evidence')]
        if quote_errors:
            evidence['error'] = quote_errors[0]
        notify = not state['open'] and (not state['last_notification_at'] or stamp - state['last_notification_at'] >= 60_000)
        if notify:
            state['last_notification_at'] = stamp
        _append(db.connection(), 'task_failure', task.id, {'source_kind': 'market',
            'dedupe_key': dedupe(task, state), 'code': 'MARKET_READ_FAILED',
            'title': '共享行情读取失败', 'attempt': str(task.result_epoch) + ':' + str(task.sequence),
            'notify_web': notify or state['open'],
            'context': {'instrument': task.query.get('instrument', ''),
                        'timeframe': 'quotes' if task.identity.get('kind') == 'quotes' else task.query.get('timeframe', ''),
                        'provider': evidence['provider'], 'task_id': task.id, 'source_id': task.id,
                        'consumer': task.identity.get('kind', 'bars')}, 'evidence': evidence})
        state['open'] = True
    if row:
        row.value = state
    else:
        db.add(Preference(key='notice:market-stream:' + task.id, value=state))


def end_observation(db, task):
    row = state_row(db, task)
    if not row or not row.value.get('open'):
        return
    state = dict(row.value)
    _append(db.connection(), 'observation_end', task.id, {'source_kind': 'market', 'dedupe_key': dedupe(task, state)})
    state.update(open=False, observation=state.get('observation', 0) + 1, last_fingerprint='')
    row.value = state
