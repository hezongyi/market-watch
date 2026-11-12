"""Real PostgreSQL channels must isolate work and deliver only committed hints."""
import os

import pytest
from alerts.publication_wakeup import (
    ALERT_CHANNEL,
    COMPOSITE_CHANNEL,
    HISTORY_CHANNEL,
    NOTICE_CHANNEL,
    STREAM_CHANNEL,
    PublicationWakeup,
    notify,
    notify_connection,
)
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'),
                               reason='Requires isolated Ubuntu PostgreSQL')


@pytest.mark.parametrize('channel', [ALERT_CHANNEL, NOTICE_CHANNEL, STREAM_CHANNEL, COMPOSITE_CHANNEL, HISTORY_CHANNEL])
def test_demand_hints_are_commit_delivered_and_unrelated_publications_do_not_wake(channel):
    engine = create_engine(os.environ['TEST_POSTGRES_URL'])
    try:
        with PublicationWakeup(engine, channel=channel) as wake:
            assert wake.connection is not None
            with Session(engine) as db, db.begin():
                notify(db)
            assert wake.wait(.05) == 'timer'
            with Session(engine) as db:
                db.begin()
                notify(db, channel)
                assert wake.wait(.05) == 'timer'
                db.rollback()
            assert wake.wait(.05) == 'timer'
            with Session(engine) as db, db.begin():
                # Sending a publication in the same transaction cannot suppress
                # the distinct demand hint via the deduplication marker.
                notify(db)
                nested = db.begin_nested()
                notify(db, channel)
                nested.rollback()
            assert wake.wait(.05) == 'timer'
            wake.prepare()
            with Session(engine) as db, db.begin():
                notify(db)
                notify(db, channel)
            assert wake.wait(1) == 'notification'
            wake.prepare()
            # Core notification source hooks use this exact path as well.
            with engine.begin() as conn:
                notify_connection(conn, channel)
            assert wake.wait(1) == 'notification'
    finally:
        engine.dispose()


def test_real_source_entrypoints_wake_their_workers_only_after_commit(provider_pg, monkeypatch):
    from alerts import (
        chart_alert_service,
        market_stream,
        notification_center,
        notification_sources,
        storage,
    )
    from test_chart_alert_service import config
    from test_market_stream import session
    from test_notification_center import browser

    factory, engine = provider_pg
    monkeypatch.setattr(storage.settings, 'fx_source', 'dukascopy')
    storage.bootstrap(engine)
    with factory.begin() as db:
        db.get(storage.Instrument, 'EURUSD').enabled = True
    with PublicationWakeup(engine, channel=NOTICE_CHANNEL) as wake:
        with factory() as db:
            notification_center.accept_browser(db, notification_center.SUBJECT, browser())
            db.flush()
            assert wake.wait(.05) == 'timer'
            db.rollback()
        assert wake.wait(.05) == 'timer'
        with factory.begin() as db:
            notification_center.accept_browser(db, notification_center.SUBJECT, browser())
        assert wake.wait(1) == 'notification'
        wake.prepare()
        monkeypatch.setattr(storage.settings, 'notification_center_sources_enabled', True)
        with engine.begin() as conn:
            notification_sources._append(conn, 'task_failure', 'fixture', {'title': 'fixture'})
            assert wake.wait(.05) == 'timer'
        assert wake.wait(1) == 'notification'
    with PublicationWakeup(engine, channel=ALERT_CHANNEL) as wake:
        with factory.begin() as db:
            ident = chart_alert_service.create(db, 'wake-alert', config(), at=0).id
            assert wake.wait(.05) == 'timer'
        assert wake.wait(1) == 'notification'
        wake.prepare()
        with factory.begin() as db:
            chart_alert_service.lifecycle(db, ident, 1, 'pause', expected_revision=1, request_id='pause', at=1)
        assert wake.wait(1) == 'notification'
    with factory.begin() as db:
        db.get(storage.Instrument, 'EURUSD').enabled = True
    owner = session(factory)
    with PublicationWakeup(engine, channel=STREAM_CHANNEL) as wake:
        market_stream.register(owner, 'page', 'bars', 1,
            {'kind': 'bars', 'series_kind': 'managed', 'instrument': 'EURUSD'}, {}, {})
        assert wake.wait(1) == 'notification'
        # Not due yet still means active demand; empty claim must not select
        # the slow idle wait merely because its next calculation is in future.
        with factory.begin() as db:
            db.query(storage.MarketStreamTask).update({'next_at': storage.now_ms() + 10000})
        activity = {}
        assert market_stream.claim(activity=activity) is None
        assert activity == {'active': True}
