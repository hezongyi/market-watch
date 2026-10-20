"""Real shared commits and projection, independent of listener/profile fanout."""
from alerts import market_stream as stream
from alerts import notification_center as center
from alerts.market_notices import error_evidence
from alerts.storage import NoticeEvent, NoticeIncident
from sqlalchemy import select
from test_market_stream import session
from test_notification_center import browser, drain

FAILED = {'type': 'quotes', 'quotes': [{'s': 'ok', 'v': {'lp': 1, 'fetch_status': 'fetch_failed'}}]}
HEALTHY = {'type': 'quotes', 'quotes': [{'s': 'ok', 'v': {'lp': 2, 'fetch_status': 'ok'}}]}


def register(owner, client='page', generation=1):
    return stream.register(owner, client, 'quote', generation,
        {'kind': 'quotes', 'metadata': {'source': 'oanda'}},
        {'instrument': 'EURUSD', 'timeframe': 'M1'}, {})


def publish(database, payload):
    with database.begin() as db:
        center.stream(db)
    work = stream.claim()
    assert work
    stream.commit(work, payload, delay_ms=0)
    drain(database)


def test_shared_failure_fanout_recovery_and_bounded_renotification(database, monkeypatch):
    owner = session(database)
    for client in ('page', 'second', 'third'):
        register(owner, client)
    publish(database, FAILED)
    for client in ('page', 'second', 'third'):
        assert stream.events(owner, client, {})[0]['notice_owner'] == 'server'
    publish(database, FAILED)
    with database() as db:
        events = list(db.scalars(select(NoticeEvent)))
        assert len(events) == 1 and events[0].attention
        assert events[0].body['evidence']['affected_subscriptions'] == 3
        assert events[0].body['evidence']['affected_clients'] == 3
        original = events[0].incident_id
    publish(database, {'type': 'status', 'status': 'pending'})
    with database() as db:
        assert db.get(NoticeIncident, original).closed_at is None
    publish(database, HEALTHY)
    with database() as db:
        assert db.get(NoticeIncident, original).closed_at is not None
    publish(database, FAILED)
    with database() as db:
        events = list(db.scalars(select(NoticeEvent).order_by(NoticeEvent.first_seq)))
        assert len(events) == 2 and events[-1].incident_id != original
        assert not events[-1].attention, 'short flaps retain evidence without another popup'


def test_last_observer_ending_is_not_a_recovery_and_resume_is_new_observation(database):
    owner = session(database)
    register(owner)
    register(owner, 'second')
    publish(database, FAILED)
    stream.cancel(owner, 'page', 'quote', 1)
    drain(database)
    with database() as db:
        row = db.scalar(select(NoticeEvent))
        assert not row.body.get('observation_status'), 'remaining observer still owns the shared task'
    stream.cancel(owner, 'second', 'quote', 1)
    drain(database)
    with database() as db:
        row = db.scalar(select(NoticeEvent))
        assert row.body['observation_status'] == 'ended'
        assert db.get(NoticeIncident, row.incident_id).closed_at is None
    register(owner, generation=2)
    publish(database, FAILED)
    with database() as db:
        rows = list(db.scalars(select(NoticeEvent).order_by(NoticeEvent.first_seq)))
        assert len(rows) == 2 and rows[0].incident_id != rows[1].incident_id
        assert not rows[1].body.get('observation_status')


def test_safe_error_evidence_never_includes_exception_text_or_proxy_credentials():
    import ssl
    secret = 'https://user:private-password@private.proxy/?token=private-token'
    try:
        try:
            raise ssl.SSLError(secret)
        except ssl.SSLError as root:
            raise ConnectionError(secret) from root
    except ConnectionError as error:
        evidence = error_evidence(error, provider='oanda', operation='quote_page')
    assert evidence['stage'] == 'tls'
    assert evidence['error_chain'] == ['ConnectionError', 'SSLError']
    assert 'private' not in str(evidence)


def test_old_loaded_clients_acknowledge_without_listener_incidents_or_false_recovery(database):
    import uuid

    from alerts.storage import MarketStreamTask
    owner = session(database)
    for client in ('page', 'second', 'third'):
        stream.register(owner, client, client + '-quote', 1,
            {'kind': 'quotes', 'metadata': {'source': 'oanda'}},
            {'instrument': 'EURUSD', 'timeframe': 'M1'}, {})
    publish(database, FAILED)
    faults = [browser(profile=str(uuid.uuid4()), source_kind='market', code='MARKET_READ_FAILED',
        context={'source_id': client + '-quote', 'generation': 1, 'consumer': 'quotes'})
        for client in ('page', 'second', 'third')]
    for fault in faults:
        with database.begin() as db:
            center.accept_browser(db, center.SUBJECT, fault)
            center.accept_browser(db, center.SUBJECT, fault)  # same durable signature
    drain(database)
    with database() as db:
        assert len(list(db.scalars(select(NoticeEvent)))) == 1
        assert db.scalar(select(NoticeIncident)).count == 1
        assert center.system_unread(db, center.SUBJECT) == 1
        for fault in faults:
            assert center.detail(db, center.SUBJECT, fault.event_id)['projection_status'] == 'shared_source'
    recovery = faults[0].model_copy(update={'event_id': 'b:' + str(uuid.uuid4()),
        'recovery_of': faults[0].event_id})
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, recovery)
    drain(database)
    with database() as db:
        assert db.scalar(select(NoticeIncident)).closed_at is None
        assert db.scalar(select(MarketStreamTask)).payload == FAILED
    # A snapshot request has another owner and must not be swallowed.
    snapshot = browser(source_kind='market', code='MARKET_READ_FAILED',
        context={'source_id': 'quote-snapshot:page-quote', 'generation': 1})
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, snapshot)
    drain(database)
    with database() as db:
        assert len(list(db.scalars(select(NoticeEvent)))) == 2


def test_healthy_first_worker_never_swallows_a_queued_preupgrade_fault(database):
    owner = session(database)
    register(owner)
    queued = browser(source_kind='market', code='MARKET_READ_FAILED',
        context={'source_id': 'quote', 'generation': 1, 'consumer': 'quotes'})
    publish(database, HEALTHY)
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, queued)
    drain(database)
    with database() as db:
        assert center.detail(db, center.SUBJECT, queued.event_id)['kind'] == 'failure'


def test_canceled_observer_can_upload_a_duplicate_captured_before_cancellation(database):
    owner = session(database)
    register(owner)
    publish(database, FAILED)
    queued = browser(source_kind='market', code='MARKET_READ_FAILED',
        context={'source_id': 'quote', 'generation': 1, 'consumer': 'quotes'})
    stream.cancel(owner, 'page', 'quote', 1)
    with database.begin() as db:
        center.accept_browser(db, center.SUBJECT, queued)
    drain(database)
    with database() as db:
        assert center.detail(db, center.SUBJECT, queued.event_id)['projection_status'] == 'shared_source'
        assert len(list(db.scalars(select(NoticeEvent)))) == 1
