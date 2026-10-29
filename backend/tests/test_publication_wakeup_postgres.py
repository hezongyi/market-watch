import os

import pytest
from alerts.publication_wakeup import PublicationWakeup, notify
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'),
                               reason='Requires isolated Ubuntu PostgreSQL')


def test_postgres_notify_delivers_after_commit_never_after_rollback_or_savepoint():
    engine = create_engine(os.environ['TEST_POSTGRES_URL'])
    try:
        with PublicationWakeup(engine) as wake:
            assert wake.connection is not None
            with Session(engine) as db:
                db.begin()
                notify(db)
                assert wake.wait(.05) == 'timer'
                db.rollback()
            assert wake.wait(.05) == 'timer'
            with Session(engine) as db:
                with db.begin():
                    nested = db.begin_nested()
                    notify(db)
                    nested.rollback()
            assert wake.wait(.05) == 'timer'
            # Listener registration precedes durable scan. A writer commits
            # exactly between the empty scan and entering the blocking wait.
            wake.prepare()
            with engine.begin() as conn:
                conn.execute(text('SELECT 1'))
            with Session(engine) as db:
                with db.begin():
                    notify(db)
                    notify(db)
            assert wake.wait(2) == 'notification'
            wake.prepare()
            wake.close()
            wake.prepare()
            assert wake.connection is not None
            with Session(engine) as db:
                with db.begin():
                    notify(db)
            assert wake.wait(2) == 'notification'
    finally:
        engine.dispose()


@pytest.mark.parametrize('cost,failure,expected', [
    (.01, False, [0, .01, .02]),
    (.01, True, [0, .26, .52]),
    (.30, False, [0, .50, 1.00]),
])
def test_committed_notifications_respect_monitor_cadence(
        monkeypatch, cost, failure, expected):
    from threading import Event

    from alerts import alert_monitor, chart_alert_worker

    engine = create_engine(os.environ['TEST_POSTGRES_URL'])
    stop, clock, starts = Event(), [0.0], []

    def step(**kwargs):
        starts.append(clock[0])
        clock[0] += cost
        with Session(engine) as db, db.begin():
            notify(db)
        if failure:
            kwargs['on_error']('ValueError')
        if len(starts) == 3:
            stop.set()
        return 1

    def wait(seconds):
        assert seconds > 0
        clock[0] += seconds
        return stop.is_set()

    try:
        with PublicationWakeup(engine, monotonic=lambda: clock[0]) as wake:
            assert wake.connection is not None
            monkeypatch.setattr(chart_alert_worker, 'step', step)
            monkeypatch.setattr(stop, 'wait', wait)
            alert_monitor.run(stop, monotonic=lambda: clock[0], wakeup=wake,
                              report_health=lambda *args, **kwargs: None)
            assert starts == pytest.approx(expected)
            assert wake.error is None
    finally:
        engine.dispose()
