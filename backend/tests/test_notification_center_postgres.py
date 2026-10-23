"""Commit-order contracts on a disposable schema in the task's Ubuntu PostgreSQL."""
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from alembic import command
from alembic.config import Config
from alerts import notification_center as center
from alerts.storage import Audit, NoticeEvent, NoticeIntake, NoticeSourceReceipt, bootstrap
from sqlalchemy import func, inspect, select
from sqlalchemy.orm import sessionmaker
from test_chart_alert_postgres import postgres_alerts as postgres_alerts
from test_notification_center import browser


def source(name):
    return Audit(kind='notice_source', details={'schema_version': 1, 'kind': 'task_failure',
        'source_id': name, 'facts': {'attempt': 1, 'dedupe_key': name,
            'code': 'TASK_FAILED', 'title': '任务失败'}})


def sessions(engine):
    bootstrap(engine)
    return sessionmaker(engine, expire_on_commit=False)


def test_reverse_source_commit_does_not_skip_lower_audit_id(postgres_alerts):
    factory = sessions(postgres_alerts)
    with factory.begin() as db:
        center.stream(db)
    first, second = factory(), factory()
    try:
        a, b = source('first'), source('second')
        first.add(a)
        first.flush()
        second.add(b)
        second.commit()
        assert a.id < b.id
        with factory.begin() as db:
            assert center.project(db) == 1
        first.commit()
        with factory.begin() as db:
            assert center.project(db) == 1
            assert db.scalar(select(func.count()).select_from(NoticeEvent)) == 2
            assert center.stream(db).seq == 2
    finally:
        first.close()
        second.close()


def test_publisher_lock_blocks_highwater_until_commit_and_rollback_is_gapless(postgres_alerts):
    factory = sessions(postgres_alerts)
    with factory.begin() as db:
        baseline = center.list_events(db, center.SUBJECT, {})
        db.add(source('visible'))
    started, finished = threading.Event(), threading.Event()
    first = factory()
    center.project(first)

    def following():
        started.set()
        with factory.begin() as db:
            result = center.project(db)
        finished.set()
        return result

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(following)
        assert started.wait(3)
        assert not finished.wait(.2)
        with factory.begin() as db:
            assert center.changes(db, center.SUBJECT, baseline['after'])['changes'] == []
        first.rollback()
        first.close()
        assert future.result(timeout=5) == 1
    with factory.begin() as db:
        result = center.changes(db, center.SUBJECT, baseline['after'])
        assert [row['seq'] for row in result['changes']] == [1]
        assert result['highwater'] == 1


def test_concurrent_same_browser_delivery_is_accepted_once(postgres_alerts):
    factory = sessions(postgres_alerts)
    value = browser()
    with factory.begin() as db:
        center.stream(db)

    def deliver():
        with factory.begin() as db:
            return center.accept_browser(db, center.SUBJECT, value)['id']

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert set(pool.map(lambda _: deliver(), range(12))) == {value.event_id}
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(NoticeIntake)) == 1
        assert center.project(db) == 1
        assert db.scalar(select(func.count()).select_from(NoticeSourceReceipt)) == 1


def test_av49_to_aw50_is_additive_repeatable_and_retains_demands(postgres_alerts, monkeypatch):
    from alerts.config import settings
    root = Path(__file__).resolve().parents[2]
    config = Config(str(root/'alembic.ini'))
    config.set_main_option('script_location', str(root/'migrations'))
    monkeypatch.setattr(settings, 'database_url', postgres_alerts.url.render_as_string(hide_password=False))
    command.upgrade(config, 'av49_indicator_demands')
    before = set(inspect(postgres_alerts).get_table_names())
    command.upgrade(config, 'head')
    command.upgrade(config, 'head')
    after = set(inspect(postgres_alerts).get_table_names())
    assert before <= after
    assert len(after-before) == 9
    assert {'notice_streams', 'notice_events', 'notice_source_receipts', 'notice_intakes', 'market_realtime_mapping_notes'} <= after
    factory = sessionmaker(postgres_alerts)
    with factory.begin() as db:
        assert center.stream(db).epoch
        db.add(source('migration-roundtrip'))
    with factory.begin() as db:
        assert center.project(db) == 1
        assert center.list_events(db, center.SUBJECT, {})['events'][0]['title'] == '任务失败'


def test_channel_reconciliation_orders_snapshot_before_concurrent_ack(postgres_alerts, monkeypatch):
    from alerts.config import settings
    from alerts.service import acknowledge
    from alerts.storage import Notification
    from sqlalchemy import event, update
    from test_notification_center import drain, trigger

    monkeypatch.setattr(settings, 'fx_source', 'dukascopy')
    factory = sessions(postgres_alerts)
    signal_id = trigger(factory)
    drain(factory)
    with factory.begin() as db:
        note_id = db.scalar(select(Notification.id).where(Notification.signal_id == signal_id))
        # Simulate the older binary, which writes phone state without source hooks.
        db.execute(update(Notification).where(Notification.id == note_id).values(status='sent'))
    captured, release, ack_started, ack_finished = (threading.Event() for _ in range(4))

    def reconcile():
        with factory.begin() as db:
            def before_flush(session, context, instances):
                if any(isinstance(row, Audit) and row.details.get('reconciled')
                       and row.details.get('kind') == 'phone_state' for row in session.new):
                    captured.set()
                    assert release.wait(5)
            event.listen(db, 'before_flush', before_flush)
            return center.reconcile_channels(db)

    def ack():
        ack_started.set()
        with factory.begin() as db:
            acknowledge(db, note_id)
        ack_finished.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        snapshot = pool.submit(reconcile)
        assert captured.wait(5)
        stopped = pool.submit(ack)
        try:
            assert ack_started.wait(3)
            assert not ack_finished.wait(.2), 'ack must wait until the snapshot source version is allocated'
        finally:
            release.set()
        assert snapshot.result(timeout=5) == 1
        stopped.result(timeout=5)
    with factory() as db:
        facts = [row for row in db.scalars(select(Audit).order_by(Audit.id))
                 if row.kind == 'notice_source' and row.details['kind'] == 'phone_state']
        assert facts[-2].details['facts']['status'] == 'sent'
        assert facts[-1].details['facts']['status'] == 'acknowledged'
        assert facts[-2].id < facts[-1].id
    drain(factory)
    with factory() as db:
        detail = center.detail(db, center.SUBJECT, center.signal_event_id(signal_id))
        assert detail['channels']['phone_state:']['status'] == 'acknowledged'
        assert detail['channels']['phone_state:']['stopped_at']
        assert center.reconcile_channels(db) == 0


def test_same_millisecond_browser_recovery_order_on_postgres(postgres_alerts, monkeypatch):
    from test_notification_center import (
        test_same_millisecond_failure_recovery_recurrence_keep_acceptance_order,
    )
    test_same_millisecond_failure_recovery_recurrence_keep_acceptance_order(sessions(postgres_alerts), monkeypatch)
