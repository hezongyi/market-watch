"""Notification polling must not scan unrelated audit history; migration retains facts."""

from pathlib import Path

from alembic import command
from alembic.config import Config
from alerts import notification_center as center
from alerts.config import settings
from alerts.storage import Audit
from sqlalchemy import event, func, select, text
from sqlalchemy.orm import sessionmaker
from test_chart_alert_postgres import postgres_alerts as postgres_alerts
from test_notification_center_postgres import source


def test_pending_notice_query_ignores_large_unrelated_history_and_downgrade_keeps_facts(
        postgres_alerts, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    config = Config(str(root/'alembic.ini'))
    config.set_main_option('script_location', str(root/'migrations'))
    monkeypatch.setattr(settings, 'database_url',
                        postgres_alerts.url.render_as_string(hide_password=False))
    command.upgrade(config, 'head')
    command.upgrade(config, 'head')
    with postgres_alerts.begin() as conn:
        conn.execute(text("INSERT INTO audit_events(kind,at,details) "
            "SELECT 'notice_source',0,'{}'::json FROM generate_series(1,2000)"))
        conn.execute(text("INSERT INTO notice_source_receipts(source_key,at) "
            "SELECT 'audit:' || id::text,0 FROM audit_events WHERE kind='notice_source'"))
        conn.execute(text("INSERT INTO audit_events(kind,at,details) "
            "SELECT 'unrelated_fixture',0,'{}'::json FROM generate_series(1,100000)"))
        conn.execute(text('ANALYZE audit_events'))
        conn.execute(text('ANALYZE notice_source_receipts'))
    factory = sessionmaker(postgres_alerts)
    with factory.begin() as db:
        db.add(source('new-after-unrelated-audits'))
    queries = []
    def record(conn, cursor, statement, parameters, context, many):
        if statement.startswith('SELECT') and 'FROM audit_events' in statement and 'notice_source_receipts' in statement:
            queries.append((statement, parameters))
    event.listen(postgres_alerts, 'before_cursor_execute', record)
    try:
        with factory.begin() as db:
            assert center.project(db) == 1
            assert center.list_events(db, center.SUBJECT, {})['events'][0]['title'] == '任务失败'
    finally:
        event.remove(postgres_alerts, 'before_cursor_execute', record)
    with postgres_alerts.connect() as conn:
        statement, parameters = queries[0]
        plan = conn.exec_driver_sql('EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) '+statement,
                                   parameters).scalar_one()[0]['Plan']
    def filtered(node):
        return node.get('Rows Removed by Filter', 0) + sum(filtered(p) for p in node.get('Plans', []))
    assert filtered(plan) < 1000, 'An idle notice poll must not filter 100,000 unrelated audit rows'
    command.downgrade(config, 'bc56_price_alert_inputs')
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(Audit)) == 102001
        assert center.project(db) == 0
    command.upgrade(config, 'head')
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(Audit)) == 102001
