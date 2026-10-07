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
