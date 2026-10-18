"""Small reliable facts captured in source transactions, never projected there."""
import re

from sqlalchemy import event, inspect, select

from .config import settings
from .storage import (
    Audit,
    ChartAlert,
    ChartAlertVersion,
    DeliveryAttempt,
    DeviceReceipt,
    HistoryVersion,
    NativeHistoryLoad,
    Notification,
    SignalRow,
    now_ms,
)


def safe_text(value, limit=1000):
    value = re.sub(r"(?i)(bearer\s+|(?:token|password|csrf|secret|authorization)\s*[:=]\s*)[^\s,;]+",
                   r"\1[已隐藏]", str(value))
    value = re.sub(r"https?://[^\s]+", "[地址已隐藏]", value)
    return value[:limit]


def _chart_signal(connection, signal_id):
    signal = connection.execute(select(SignalRow.__table__).where(SignalRow.id == signal_id)).mappings().first()
    if not signal or not signal['chart_alert_id']:
        return None
    version = signal['evidence'].get('rule_version')
    if not connection.scalar(select(ChartAlert.id).where(ChartAlert.id == signal['chart_alert_id'])):
        return None
    if not connection.scalar(select(ChartAlertVersion.id).where(
        ChartAlertVersion.alert_id == signal['chart_alert_id'], ChartAlertVersion.version == version)):
        return None
    return signal


def _append(connection, kind, source_id, facts):
    if not settings.notification_center_sources_enabled:
        return
    connection.execute(Audit.__table__.insert().values(kind='notice_source', at=now_ms(),
        details={'schema_version': 1, 'kind': kind, 'source_id': str(source_id), 'facts': facts}))


@event.listens_for(SignalRow, 'after_insert')
def signal_created(mapper, connection, signal):
    if _chart_signal(connection, signal.id):
        _append(connection, 'signal', signal.id, {'signal_id': signal.id})


@event.listens_for(Notification, 'after_insert')
@event.listens_for(Notification, 'after_update')
def phone_state(mapper, connection, note):
    if not any(inspect(note).attrs[key].history.has_changes() for key in ('status', 'ack_at')):
        return
    if _chart_signal(connection, note.signal_id):
        _append(connection, 'phone_state', note.id, {'signal_id': note.signal_id,
            'notification_id': note.id, 'status': note.status, 'stopped_at': note.ack_at})


@event.listens_for(DeliveryAttempt, 'after_insert')
def phone_attempt(mapper, connection, attempt):
    note = connection.execute(select(Notification.__table__).where(
        Notification.id == attempt.notification_id)).mappings().first()
    if note and _chart_signal(connection, note['signal_id']):
        _append(connection, 'phone_attempt', attempt.id, {'signal_id': note['signal_id'],
            'notification_id': attempt.notification_id, 'attempt_id': attempt.id, 'at': attempt.at,
            'status': attempt.status, 'details': {key: safe_text(attempt.details[key]) for key in
                ('provider_id', 'status_code', 'error') if key in attempt.details}})


@event.listens_for(DeviceReceipt, 'after_insert')
def phone_received(mapper, connection, receipt):
    note = connection.execute(select(Notification.__table__).where(
        Notification.id == receipt.notification_id)).mappings().first()
    if note and _chart_signal(connection, note['signal_id']):
        _append(connection, 'phone_received', receipt.id, {'signal_id': note['signal_id'],
            'notification_id': receipt.notification_id, 'device_id': receipt.device_id,
            'received_at': receipt.received_at})


def native_result(db, ident):
    # Native history commits through Core updates. This is in that same gated
    # source transaction, after its generation/lease update actually succeeded.
    task = db.get(NativeHistoryLoad, ident, populate_existing=True)
    if not task or task.state not in ('failed', 'ready'):
        return
    if task.state == 'ready':
        _append(db.connection(), 'recovery', task.id, {'dedupe_key': 'native_history:' + task.id})
        return
    query = task.query_json
    _append(db.connection(), 'task_failure', task.id, {'dedupe_key': 'native_history:' + task.id,
        'code': 'NATIVE_HISTORY_FAILED', 'title': '图格历史读取失败', 'attempt': task.generation,
        'context': {key: query[key] for key in ('instrument', 'timeframe', 'series_kind', 'before')
                    if key in query}, 'evidence': task.error_json or {}})


@event.listens_for(HistoryVersion, 'after_update')
def data_task_state(mapper, connection, task):
    if not inspect(task).attrs.status.history.has_changes():
        return
    if task.status == 'published':
        _append(connection, 'recovery', task.id, {'dedupe_key': 'history_task:' + task.id})
    elif task.status in ('failed', 'configuration_error'):
        _append(connection, 'task_failure', task.id, {'dedupe_key': 'history_task:' + task.id,
            'code': task.error or 'HISTORY_TASK_FAILED', 'title': '图表数据中心历史任务失败',
            'attempt': task.attempts, 'context': {'dataset_id': task.dataset_id},
            'evidence': {'start': task.start, 'end': task.end, 'cursor': task.cursor,
                         'attempts': task.attempts, 'reason': safe_text(task.error or '')}})
