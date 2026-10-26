"""Observable reliability contracts, using real chart producers and source transactions."""
import uuid

import pytest
from alerts import notification_center as center
from alerts.chart_alert_service import consume, create
from alerts.notification_center_api import BrowserEvent, Observation
from alerts.service import acknowledge
from alerts.storage import (
    Audit,
    DeliveryAttempt,
    NoticeChange,
    NoticeEvent,
    NoticeIncident,
    NoticeIntake,
    NoticeObservation,
    NoticeSourceReceipt,
    Notification,
    Outbox,
    SignalRow,
    now_ms,
)
from fastapi import HTTPException
from sqlalchemy import func, select
from test_chart_alert_service import config, sample

PROFILE = str(uuid.uuid4())


def trigger(database, *, web=True, ntfy=True):
    at = now_ms()
    with database.begin() as db:
        center.stream(db)
        alert = create(db, str(uuid.uuid4()), config(notify_web=web, notify_ntfy=ntfy), at=at - 300_001)
        consume(db, alert.id, sample(1, 9, timestamp=at - 300_000), detected_at=at - 300_000)
        event = consume(db, alert.id, sample(2, 11, timestamp=at), detected_at=at)
        return event.id


def drain(database):
    while True:
        with database.begin() as db:
            if not center.project(db):
                return


def browser(**changes):
    return BrowserEvent.model_validate({'event_id': 'b:' + str(uuid.uuid4()), 'profile': PROFILE,
        'source_kind': 'workspace', 'attempt_id': str(uuid.uuid4()), 'code': 'SAVE_FAILED',
        'occurred_at': now_ms(), 'title': '保存失败', 'message': '请保留草稿',
        'context': {'workspace_id': 'workspace-a'}, **changes})


def test_browser_observation_end_is_not_recovery_and_samples_are_isolated(database):
    first = browser(source_kind='market', code='MARKET_READ_FAILED')
    sample_fault = browser(source_kind='market', code='MARKET_READ_FAILED',
        context={**first.context, 'acceptance_run': 'batch-13-21'})
    with database.begin() as db:
        center.stream(db)
        center.accept_browser(db, center.SUBJECT, first)
        center.accept_browser(db, center.SUBJECT, sample_fault)
    drain(database)
    end = browser(source_kind='market', code='MARKET_READ_FAILED',
        context=first.context, recovery_of=first.event_id, observation_ended=True)
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, end)
    drain(database)
    with database() as db:
        natural = center.detail(db, center.SUBJECT, first.event_id)
        sample_event = center.detail(db, center.SUBJECT, sample_fault.event_id)
        assert natural['incident_id'] != sample_event['incident_id']
        assert natural['observation_status'] == 'ended'
        assert natural['incident']['closed_at'] is None
        assert not sample_event.get('observation_status')
    wrong_recovery = browser(source_kind='market', code='MARKET_READ_FAILED',
        context=sample_fault.context, recovery_of=first.event_id)
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, wrong_recovery)
    drain(database)
    with database() as db:
        assert center.detail(db, center.SUBJECT, first.event_id)['incident']['closed_at'] is None


def test_browser_default_end_flag_keeps_old_intake_signature(database):
    value = browser()
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, value)
        intake = db.get(NoticeIntake, value.event_id)
        assert 'observation_ended' not in intake.body
        assert center.accept_browser(db, center.SUBJECT,
            value.model_copy(update={'observation_ended': False}))['id'] == value.event_id


def observe(ident, kind='viewed', **changes):
    return Observation.model_validate({'observation_id': str(uuid.uuid4()), 'event_id': ident,
        'profile': PROFILE, 'kind': kind, **changes})


def test_real_source_is_independent_and_projection_crash_is_atomic(database):
    signal_id = trigger(database)
    with database() as db:
        assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 0
        assert db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == 'notice_source')) >= 2
        assert db.get(SignalRow, signal_id)
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
    with pytest.raises(RuntimeError, match='Injected'):
        with database.begin() as db:
            center.project(db, fail_after=1)
    with database() as db:
        assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 0
        assert db.scalar(select(func.count()).select_from(NoticeSourceReceipt)) == 0
        assert center.stream(db).seq == 0
    drain(database)
    drain(database)
    with database() as db:
        rows = list(db.scalars(select(NoticeEvent)))
        assert len(rows) == 1 and rows[0].id == center.signal_event_id(signal_id)
        assert db.get(NoticeIncident, rows[0].incident_id).count == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_web_read_and_handled_do_not_stop_phone_old_ack_does(database):
    signal_id = trigger(database)
    drain(database)
    event_id = center.signal_event_id(signal_id)
    with database.begin() as db:
        view = observe(event_id)
        assert not center.observe(db, center.SUBJECT, view)['duplicate']
        assert center.observe(db, center.SUBJECT, view)['duplicate']
        center.observe(db, center.SUBJECT, observe(event_id, 'handled'))
    with database.begin() as db:
        note = db.scalar(select(Notification).where(Notification.signal_id == signal_id))
        assert not note.ack_at
        assert db.scalar(select(Outbox).where(Outbox.notification_id == note.id)).status == 'pending'
        acknowledge(db, note.id)
    drain(database)
    with database() as db:
        row = db.get(NoticeEvent, event_id)
        assert row.viewed_at and row.handled_at
        assert row.body['channels']['phone_state:']['stopped_at']
        assert db.get(NoticeIncident, row.incident_id).count == 1


def test_phone_change_catches_up_without_new_occurrence(database):
    signal_id = trigger(database)
    drain(database)
    with database.begin() as db:
        baseline = center.list_events(db, center.SUBJECT, {})
        note = db.scalar(select(Notification).where(Notification.signal_id == signal_id))
        db.add(DeliveryAttempt(notification_id=note.id, status='failed_or_unknown', details={'error': 'ReadTimeout'}))
    drain(database)
    with database() as db:
        updates = center.changes(db, center.SUBJECT, baseline['after'])
        assert updates['changes'] and all(c['kind'] == 'updated' for c in updates['changes'])
        row = center.detail(db, center.SUBJECT, center.signal_event_id(signal_id))
        assert row['incident']['count'] == 1
        timeline = center.timeline(db, center.SUBJECT, row['id'])
        assert any(r['kind'] == 'phone_attempt' for r in timeline['observations'])


def test_browser_idempotence_conflict_and_sanitized_evidence(database):
    event = browser(evidence={'password': 'should-not-survive', 'reason': 'https://private.example?a=secret'})
    with database.begin() as db:
        center.stream(db)
        first = center.accept_browser(db, center.SUBJECT, event)
    with database.begin() as db:
        assert center.accept_browser(db, center.SUBJECT, event) == first
        with pytest.raises(HTTPException) as error:
            center.accept_browser(db, center.SUBJECT, event.model_copy(update={'message': 'different'}))
        assert error.value.status_code == 409
    drain(database)
    with database() as db:
        row = center.detail(db, center.SUBJECT, event.event_id)
        assert 'password' not in row['evidence'] and 'private.example' not in str(row)
        assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 1


def test_history_incident_queries_are_batched_for_a_full_page(database):
    from sqlalchemy import event

    with database.begin() as db:
        state = center.stream(db, lock=True)
        for i in range(100):
            center._new_event(db, state, ident='batch:' + str(i), source_kind='market',
                source_id=str(i), occurred_at=now_ms(), body={'title': 'batch', 'context': {}},
                dedupe=['batch', i])
    statements = []
    with database() as db:
        engine = db.get_bind()
        def count(_conn, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)
        event.listen(engine, 'before_cursor_execute', count)
        try:
            page = center.list_events(db, center.SUBJECT, {'audience': 'system'}, limit=100)
        finally:
            event.remove(engine, 'before_cursor_execute', count)
    assert len(page['events']) == 100
    assert all(row['incident']['count'] == 1 for row in page['events'])
    incident_reads = [sql for sql in statements if 'FROM notice_incidents' in sql]
    assert len(incident_reads) == 1, f'expected one batch read, got {len(incident_reads)}'
    assert len(statements) <= 10, len(statements)


def test_fault_attempts_group_retransmit_does_not_and_explicit_recovery_reopens(database):
    first, second = browser(), browser(message='different text same stable code')
    for event in (first, second):
        with database.begin() as db:
            center.stream(db)
            center.accept_browser(db, center.SUBJECT, event)
        drain(database)
    with database() as db:
        one, two = db.get(NoticeEvent, first.event_id), db.get(NoticeEvent, second.event_id)
        assert one.incident_id == two.incident_id and one.attention and not two.attention
        assert db.get(NoticeIncident, one.incident_id).count == 2
    # A delayed recovery of an older attempt cannot close a newer failure.
    for target in (first.event_id, second.event_id):
        with database.begin() as db:
            center.accept_browser(db, center.SUBJECT, browser(recovery_of=target))
        drain(database)
        with database() as db:
            group = db.get(NoticeIncident, db.get(NoticeEvent, second.event_id).incident_id)
            assert bool(group.closed_at) == (target == second.event_id)
    third = browser()
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, third)
    drain(database)
    with database() as db:
        assert db.get(NoticeEvent, third.event_id).incident_id != db.get(NoticeEvent, first.event_id).incident_id
        assert db.get(NoticeEvent, third.event_id).attention


def test_history_over_500_uses_highwater_and_immutable_keyset(database):
    with database.begin() as db:
        center.stream(db)
        for i in range(603):
            value = browser(occurred_at=123456, attempt_id=str(i))
            # Projection load fixtures bypass ingress rate limits, never the producer integration tests.
            raw = value.model_dump(mode='json')
            raw['dedupe_context'] = raw['context']
            db.add(NoticeIntake(id=value.event_id, subject=center.SUBJECT, profile=PROFILE,
                intent_hash=center.intent_hash(raw), body=raw))
    drain(database)
    seen = []
    with database.begin() as db:
        page = center.list_events(db, center.SUBJECT, {}, limit=80)
    first_high = page['highwater']
    later = browser(occurred_at=0)
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, later)
    drain(database)
    while True:
        seen += [r['id'] for r in page['events']]
        assert page['highwater'] == first_high
        if not page['before']:
            break
        with database.begin() as db:
            page = center.list_events(db, center.SUBJECT, {}, before=page['before'], limit=80)
    assert len(seen) == len(set(seen)) == 603 and later.event_id not in seen


def test_cursor_binding_reset_and_observation_updates_leave_filter(database):
    value = browser()
    with database.begin() as db:
        center.stream(db)
        center.accept_browser(db, center.SUBJECT, value)
    drain(database)
    with database.begin() as db:
        baseline = center.list_events(db, center.SUBJECT, {'state': 'unread'})
        center.observe(db, center.SUBJECT, observe(value.event_id))
    with database.begin() as db:
        result = center.changes(db, center.SUBJECT, baseline['after'])
        assert result['changes'][-1]['body']['viewed_at']
        assert center.list_events(db, center.SUBJECT, {'state': 'unread'})['events'] == []
        state = center.stream(db, lock=True)
        state.epoch = str(uuid.uuid4())
    with database.begin() as db, pytest.raises(HTTPException) as error:
        center.changes(db, center.SUBJECT, baseline['after'])
    assert error.value.status_code == 409 and error.value.detail['code'] == 'NOTICE_RESET'


def test_fake_server_channels_and_subjects_are_rejected():
    from pydantic import ValidationError
    for payload in ({'subject': 'another'}, {'source_kind': 'chart_alert'}, {'channels': {'phone': 'accepted'}}):
        with pytest.raises(ValidationError):
            browser(**payload)
    with pytest.raises(ValidationError):
        observe('any', kind='phone_received')


def test_retention_tombstones_and_cursor_gap_do_not_remove_source_receipts(database):
    signal_id = trigger(database)
    drain(database)
    with database.begin() as db:
        baseline = center.list_events(db, center.SUBJECT, {})
        row = db.get(NoticeEvent, center.signal_event_id(signal_id))
        row.recorded_at = now_ms() - 31 * 86400_000
        count = db.scalar(select(func.count()).select_from(NoticeSourceReceipt))
    with database.begin() as db:
        assert center.retain(db) == 1
        result = center.changes(db, center.SUBJECT, baseline['after'])
        assert result['changes'][-1]['kind'] == 'deleted'
        assert db.scalar(select(func.count()).select_from(NoticeSourceReceipt)) == count
    drain(database)
    with database() as db:
        assert not db.get(NoticeEvent, center.signal_event_id(signal_id))
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.scalar(select(func.count()).select_from(NoticeChange)) > 0


def test_subject_cannot_read_another_subject_or_forge_receipt(database):
    value = browser()
    with database.begin() as db:
        center.stream(db)
        center.accept_browser(db, center.SUBJECT, value)
    drain(database)
    with database.begin() as db, pytest.raises(HTTPException) as error:
        center.detail(db, 'different-principal', value.event_id)
    assert error.value.status_code == 404
    with database() as db:
        assert db.scalar(select(func.count()).select_from(NoticeObservation)) == 0


def test_rebuild_preserves_observations_and_never_recounts_or_resends(database):
    ident = center.signal_event_id(trigger(database))
    drain(database)
    with database.begin() as db:
        center.observe(db, center.SUBJECT, observe(ident))
        baseline = center.list_events(db, center.SUBJECT, {})
        count = db.scalar(select(func.count()).select_from(Outbox))
        group_id = db.get(NoticeEvent, ident).incident_id
        center.rebuild(db)
    drain(database)
    with database.begin() as db:
        row = db.get(NoticeEvent, ident)
        assert row.viewed_at and row.backfill and not row.attention
        assert db.get(NoticeIncident, group_id).count == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == count
        assert db.scalar(select(func.count()).select_from(NoticeObservation)) >= 1
        with pytest.raises(HTTPException) as error:
            center.changes(db, center.SUBJECT, baseline['after'])
        assert error.value.status_code == 409


def test_projection_delay_does_not_make_sound_fresh_and_late_log_only_is_inert(database):
    at = now_ms()
    with database.begin() as db:
        center.stream(db)
        alert = create(db, str(uuid.uuid4()), config(notify_web=True, notify_ntfy=True), at=at-600001)
        consume(db, alert.id, sample(1, 9, timestamp=at-600000), detected_at=at-600000)
        signal = consume(db, alert.id, sample(2, 11, timestamp=at-300000), detected_at=at)
        ident = center.signal_event_id(signal.id)
    drain(database)
    with database() as db:
        row = db.get(NoticeEvent, ident)
        assert row.kind == 'alert' and not row.attention
        assert row.body['accepted_at'] == at and not row.body['notify_web']
        assert row.body['late_delivery'] == 'log_only'


def test_recovery_cannot_close_another_profile_or_context(database):
    fault = browser()
    with database.begin() as db:
        center.stream(db)
        center.accept_browser(db, center.SUBJECT, fault)
    drain(database)
    for changes in ({'profile': str(uuid.uuid4())}, {'context': {'workspace_id': 'another'}}):
        recovery = browser(recovery_of=fault.event_id, **changes)
        with database.begin() as db:
            center.accept_browser(db, center.SUBJECT, recovery)
        drain(database)
        with database() as db:
            row = db.get(NoticeEvent, fault.event_id)
            assert db.get(NoticeIncident, row.incident_id).closed_at is None


def test_backfill_only_pre_install_chart_sources_and_is_repeatable(database):
    from alerts.storage import NoticeStream
    ident = trigger(database)
    with database.begin() as db:
        db.execute(NoticeSourceReceipt.__table__.delete())
        db.execute(Audit.__table__.delete().where(Audit.kind == 'notice_source'))
        db.get(NoticeStream, center.SUBJECT).started_at = now_ms()+1000
        assert center.backfill(db) == 1
        assert center.backfill(db) == 0
    with database() as db:
        row = db.get(NoticeEvent, center.signal_event_id(ident))
        assert row.backfill and not row.attention
        assert row.body['historical_observations'].startswith('未存储')


def test_native_history_only_matching_range_success_closes_incident(database):
    from alerts.notification_sources import native_result
    from alerts.storage import NativeHistoryLoad

    query = {'instrument': 'OANDA:EUR_USD', 'timeframe': 'H1', 'series_kind': 'provider',
             '_notice_context': {'workspace_id': 'workspace-a', 'chart_index': 'window-a'}}
    with database.begin() as db:
        center.stream(db)
        failed = NativeHistoryLoad(id='native-failed', owner='owner', request_id='attempt-a',
            query_json={**query, 'before': 10}, state='failed', deadline=100, consumer_until=100,
            generation=2, error_json={'code': 'HISTORY_UNAVAILABLE'})
        db.add(failed)
        db.flush()
        native_result(db, failed.id)
    drain(database)
    with database() as db:
        row = db.scalar(select(NoticeEvent))
        ident, group = row.id, row.incident_id
        assert row.source_kind == 'history' and row.workspace == 'workspace-a'
        assert not db.get(NoticeIncident, group).closed_at
    with database.begin() as db:
        success = NativeHistoryLoad(id='native-success', owner='owner', request_id='attempt-b',
            query_json={**query, 'before': 20}, state='ready', deadline=100, consumer_until=100)
        db.add(success)
        db.flush()
        native_result(db, success.id)
    drain(database)
    with database() as db:
        assert not db.get(NoticeIncident, group).closed_at
    with database.begin() as db:
        matching = NativeHistoryLoad(id='native-matching', owner='owner', request_id='attempt-c',
            query_json={**query, 'before': 10}, state='ready', deadline=100, consumer_until=100)
        db.add(matching)
        db.flush()
        native_result(db, matching.id)
    drain(database)
    with database() as db:
        assert db.get(NoticeIncident, group).closed_at
        assert db.get(NoticeEvent, ident)
        assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 1


def test_unprocessed_old_sources_are_not_discarded_by_retention_age(database):
    old = now_ms() - 40 * 86400_000
    ident = trigger(database)
    value = browser()
    with database.begin() as db:
        db.get(SignalRow, ident).created_at = old
        for source in db.scalars(select(Audit).where(Audit.kind == 'notice_source')):
            source.at = old
        center.accept_browser(db, center.SUBJECT, value)
        db.flush()
        db.get(NoticeIntake, value.event_id).at = old
    drain(database)
    with database() as db:
        assert db.get(NoticeEvent, center.signal_event_id(ident))
        assert db.get(NoticeEvent, value.event_id)


def test_rollforward_reconciles_phone_attempt_receipt_and_stop(database, monkeypatch):
    from alerts.config import settings
    from alerts.storage import Device, DeviceReceipt
    signal_id = trigger(database)
    drain(database)
    monkeypatch.setattr(settings, 'notification_center_sources_enabled', False)
    with database.begin() as db:
        note = db.scalar(select(Notification).where(Notification.signal_id == signal_id))
        db.add(Device(id='rollback-device', name='fixture', token_hash='fixture-only'))
        db.flush()
        db.add(DeliveryAttempt(notification_id=note.id, status='failed_or_unknown', details={'error': 'offline'}))
        db.add(DeviceReceipt(notification_id=note.id, device_id='rollback-device'))
        acknowledge(db, note.id)
    monkeypatch.setattr(settings, 'notification_center_sources_enabled', True)
    with database.begin() as db:
        assert center.reconcile_channels(db) == 3
    drain(database)
    with database.begin() as db:
        assert center.reconcile_channels(db) == 0
        row = center.detail(db, center.SUBJECT, center.signal_event_id(signal_id))
        assert row['channels']['phone_state:']['stopped_at']
        assert row['incident']['count'] == 1
        kinds = [item['kind'] for item in center.timeline(db, center.SUBJECT, row['id'])['observations']]
        assert kinds.count('phone_attempt') == 1 and kinds.count('phone_received') == 1


def test_rebuild_does_not_resurrect_expired_events(database):
    signal_id = trigger(database)
    drain(database)
    with database.begin() as db:
        db.get(NoticeEvent, center.signal_event_id(signal_id)).recorded_at = now_ms() - 31 * 86400_000
    with database.begin() as db:
        center.retain(db)
    with database.begin() as db:
        center.rebuild(db)
    drain(database)
    with database() as db:
        assert not db.get(NoticeEvent, center.signal_event_id(signal_id))


def test_same_millisecond_failure_recovery_recurrence_keep_acceptance_order(database, monkeypatch):
    fixed = now_ms()
    monkeypatch.setattr(center, 'now_ms', lambda: fixed)
    first = browser(event_id='b:' + str(uuid.UUID(int=2**128-1)), occurred_at=fixed)
    recovery = browser(event_id='b:' + str(uuid.UUID(int=2)), recovery_of=first.event_id, occurred_at=fixed)
    recurrence = browser(event_id='b:' + str(uuid.UUID(int=1)), occurred_at=fixed)
    for value in (first, recovery, recurrence):
        with database.begin() as db:
            center.accept_browser(db, center.SUBJECT, value)
            # Lost responses/retransmission must not allocate another position.
            center.accept_browser(db, center.SUBJECT, value)
    with pytest.raises(RuntimeError, match='Injected'):
        with database.begin() as db:
            center.project(db, limit=1, fail_after=1)
    for _ in range(3):
        with database.begin() as db:
            assert center.project(db, limit=1) == 1
    with database.begin() as db:
        assert center.project(db, limit=1) == 0
        a, b = db.get(NoticeEvent, first.event_id), db.get(NoticeEvent, recurrence.event_id)
        assert a.incident_id != b.incident_id
        assert db.get(NoticeIncident, a.incident_id).closed_at == fixed
        assert not db.get(NoticeIncident, b.incident_id).closed_at
        assert db.get(NoticeIncident, a.incident_id).count == 1
        assert db.get(NoticeIncident, b.incident_id).count == 1
        rows = [db.get(NoticeIntake, value.event_id) for value in (first, recovery, recurrence)]
        assert len({row.at for row in rows}) == 1
        assert [row.body['_accepted_order'] for row in rows] == sorted(row.body['_accepted_order'] for row in rows)
        assert db.scalar(select(func.count()).select_from(NoticeSourceReceipt)) == 3


def test_chart_plan_terminal_source_is_atomic_excludes_legacy_and_allows_same_attempt_recurrence(database):
    from alerts.storage import ImportJob
    with database.begin() as db:
        center.stream(db)
        chart = ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0, chart_plan=True)
        legacy = ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0)
        db.add_all([chart, legacy])
        db.flush()
        chart_id, legacy_id = chart.id, legacy.id
    with pytest.raises(RuntimeError):
        with database.begin() as db:
            db.get(ImportJob, chart_id).status = 'failed'
            db.flush()
            raise RuntimeError('source rollback')
    with database() as db:
        assert not db.scalar(select(Audit).where(Audit.kind == 'notice_source'))
    with database.begin() as db:
        for ident in (chart_id, legacy_id):
            task = db.get(ImportJob, ident)
            task.status, task.attempts, task.error = 'failed', 5, 'provider timeout'
    drain(database)
    with database() as db:
        rows = list(db.scalars(select(NoticeEvent)))
        assert len(rows) == 1 and rows[0].source_id == chart_id
        first_id, first_group = rows[0].id, rows[0].incident_id
    with database.begin() as db:
        db.get(ImportJob, chart_id).status = 'complete'
    drain(database)
    with database() as db:
        assert db.get(NoticeIncident, first_group).closed_at
    with database.begin() as db:
        db.get(ImportJob, chart_id).status = 'pending'
    with database.begin() as db:
        db.get(ImportJob, chart_id).status = 'failed'
    drain(database)
    with database() as db:
        rows = list(db.scalars(select(NoticeEvent)))
        assert len(rows) == 2 and len({row.id for row in rows}) == 2
        recurrence = next(row for row in rows if row.id != first_id)
        assert recurrence.incident_id != first_group and recurrence.attention


def test_export_background_job_is_owned_after_window_closes(database):
    from alerts.notification_sources import chart_import_scope
    from alerts.storage import ImportJob
    with database.begin() as db:
        center.stream(db)
        job = ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0)
        db.add(job)
        db.flush()
        ident = job.id
        chart_import_scope(db, [job], {'workspace_id': 'export-workspace', 'timeframe': 'H1', 'endpoint': '/charts/export'})
        chart_import_scope(db, [job], {'workspace_id': 'export-workspace', 'timeframe': 'H1', 'endpoint': '/charts/export'})
    with database.begin() as db:
        task = db.get(ImportJob, ident)
        task.status, task.attempts = 'failed', 5
    drain(database)
    with database() as db:
        row = db.scalar(select(NoticeEvent))
        assert row.source_id == ident and row.body['context']['workspace_id'] == 'export-workspace'
        assert row.body['context']['endpoint'] == '/charts/export'
        assert row.body['context']['timeframe'] == 'H1'
        assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 1


def test_export_attaches_to_existing_failed_job_once(database):
    from alerts.notification_sources import chart_import_scope
    from alerts.storage import ImportJob
    with database.begin() as db:
        center.stream(db)
        job = ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0, status='failed', attempts=5)
        db.add(job)
        db.flush()
        chart_import_scope(db, [job], {'endpoint': '/charts/export'})
        chart_import_scope(db, [job], {'endpoint': '/charts/export'})
    drain(database)
    with database() as db:
        assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 1


def test_native_recovery_requires_matching_request_range():
    from alerts.notification_sources import native_key
    query = {'instrument': 'EURUSD', 'timeframe': 'H1', 'before': 1000000, 'countBack': 4000,
             '_notice_context': {'workspace_id': 'a', 'chart_index': '0'}}
    assert native_key(query) == native_key(dict(query))
    assert native_key(query) != native_key({**query, 'before': 2000000})
    assert native_key(query) != native_key({**query, 'countBack': 100})


def test_system_center_groups_occurrences_excludes_trades_and_reads_only_snapshot(database):
    from alerts.notification_center_api import SystemRead

    signal_id = trigger(database)
    first = browser(attempt_id='first', context={'workspace_id': 'workspace-a', 'source_id': 'save'})
    repeat = browser(attempt_id='repeat', context={'workspace_id': 'workspace-a', 'source_id': 'save'})
    other = browser(source_kind='market', code='MARKET_FAILED')
    with database.begin() as db:
        for value in (first, repeat, other):
            center.accept_browser(db, center.SUBJECT, value)
    drain(database)
    with database.begin() as db:
        page = center.list_events(db, center.SUBJECT, {'audience': 'system'}, limit=1)
        all_rows = page['events'][:]
        cursor = page['before']
        while cursor:
            following = center.list_events(db, center.SUBJECT, {'audience': 'system'}, before=cursor, limit=1)
            all_rows.extend(following['events'])
            cursor = following['before']
        assert len(all_rows) == 2
        assert {row['source_kind'] for row in all_rows} == {'workspace', 'market'}
        assert sorted(row['incident']['count'] for row in all_rows) == [1, 2]
        assert page['system_unread'] == 2
        cutoff, epoch = page['highwater'], page['epoch']
        newer = browser(source_kind='indicator', code='INDICATOR_FAILED')
        center.accept_browser(db, center.SUBJECT, newer)
    drain(database)
    with database.begin() as db:
        result = center.read_system(db, center.SUBJECT, SystemRead(profile=PROFILE, through=cutoff, epoch=epoch))
        assert result == {'read': 3, 'more': False, 'system_unread': 1}
        trade = db.get(NoticeEvent, center.signal_event_id(signal_id))
        assert trade.viewed_at is None and trade.handled_at is None
        phone = db.scalar(select(Notification).where(Notification.signal_id == signal_id))
        assert phone.ack_at is None
        assert db.get(NoticeEvent, newer.event_id).viewed_at is None
        assert db.get(NoticeEvent, first.event_id).handled_at is None
        assert center.read_system(db, center.SUBJECT, SystemRead(profile=PROFILE, through=cutoff, epoch=epoch))['read'] == 0
        resolved = center.resolve_signal(db, signal_id)
        assert '?panel=notifications&event=' in resolved['destination']
        assert resolved['destination'].startswith('/advanced-charts?')
        with pytest.raises(HTTPException) as error:
            center.read_system(db, center.SUBJECT, SystemRead(profile=PROFILE, through=cutoff, epoch='obsolete'))
        assert error.value.status_code == 409


def test_system_read_is_bounded_and_incident_scoped(database):
    from alerts.notification_center_api import SystemRead

    with database.begin() as db:
        state = center.stream(db, lock=True)
        for i in range(105):
            center._new_event(db, state, ident='bounded-' + str(i), source_kind='workspace',
                source_id=str(i), occurred_at=now_ms(), body={'title': 'failure'}, dedupe='one-incident')
        other = center._new_event(db, state, ident='other', source_kind='market', source_id='other',
            occurred_at=now_ms(), body={'title': 'other'})
        grouped = center.list_events(db, center.SUBJECT, {'audience': 'system'})
        incident = next(row for row in grouped['events'] if row['id'] != other.id)['incident_id']
        raw = center.list_events(db, center.SUBJECT, {'audience': 'system', 'grouped': False, 'incident': incident})
        assert len(raw['events']) == 100 and raw['before']
        assert len(center.list_events(db, center.SUBJECT, {'audience': 'system', 'grouped': False, 'incident': incident}, before=raw['before'])['events']) == 5
        read = SystemRead(profile=PROFILE, through=state.seq, epoch=state.epoch, incident_id=incident)
        first = center.read_system(db, center.SUBJECT, read)
        assert first['read'] == 100 and first['more']
        unread = center.list_events(db, center.SUBJECT, {
            'audience': 'system', 'grouped': False, 'incident': incident, 'state': 'unread'})
        assert len(unread['events']) == 5
        second = center.read_system(db, center.SUBJECT, read)
        assert second['read'] == 5 and not second['more']
        assert other.viewed_at is None
        assert center.system_unread(db, center.SUBJECT) == 1


def test_system_search_decodes_unicode_and_treats_wildcards_literally(database):
    with database.begin() as db:
        state = center.stream(db, lock=True)
        for ident, title in [('chinese', '连接异常：完成 50%_检查'), ('other', '连接已恢复')]:
            center._new_event(db, state, ident=ident, source_kind='connection', source_id=ident,
                occurred_at=now_ms(), body={'title': title, 'message': '受控验收记录'})
        for query in ('连接异常', '50%_', '受控验收'):
            rows = center.list_events(db, center.SUBJECT, {'audience': 'system', 'q': query})['events']
            assert {row['id'] for row in rows} == ({'chinese', 'other'} if query == '受控验收' else {'chinese'})


def test_history_sort_cursors_cover_all_rows_and_keep_default_compatible(database):
    at = now_ms() - 20000
    values = [browser(occurred_at=at + i // 2 * 1000, code=f"SORT_{i}") for i in range(7)]
    with database.begin() as db:
        center.stream(db)
        for value in reversed(values):
            center.accept_browser(db, center.SUBJECT, value)
    drain(database)
    with database() as db:
        expected = sorted([(value.occurred_at, value.event_id) for value in values])
        for sort in ('oldest', 'newest'):
            filters = {'audience': 'system', 'sort': sort}
            page = center.list_events(db, center.SUBJECT, filters, limit=2)
            found = []
            while True:
                found.extend((row['occurred_at'], row['id']) for row in page['events'])
                if not page['before']:
                    break
                with pytest.raises(HTTPException):
                    center.list_events(db, center.SUBJECT,
                        {'audience': 'system', 'sort': 'newest' if sort == 'oldest' else 'oldest'},
                        before=page['before'], limit=2)
                page = center.list_events(db, center.SUBJECT, filters, before=page['before'], limit=2)
            assert found == (expected if sort == 'oldest' else list(reversed(expected)))
        default = center.list_events(db, center.SUBJECT, {'audience': 'system'}, limit=2)
        implicit = center.list_events(db, center.SUBJECT, {'audience': 'system'}, before=default['before'])
        explicit = center.list_events(db, center.SUBJECT, {'audience': 'system', 'sort': 'newest'}, before=default['before'])
        assert [row['id'] for row in implicit['events']] == [row['id'] for row in explicit['events']]
