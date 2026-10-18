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
