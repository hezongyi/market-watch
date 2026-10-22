"""Regress the real ownership/projection seams without upstream network IO."""
import httpx
import pytest
from sqlalchemy import event, select

from alerts import live_pricing as live, notification_center as center
from alerts.config import settings
from alerts.live_confirmation import health
from alerts.market_contracts import RequestResult, failed_request
from alerts.storage import LiveState, MarketComposite, NoticeEvent, NoticeIncident, now_ms
from test_live_pricing import running, candles, quote
from test_series_access import fixture


@pytest.mark.parametrize('lead', [0, 5000, 7000, 15000])
@pytest.mark.parametrize('latency', [0, 500, 2000])
def test_margin_keeps_confirmation_window_behind_provider(lead, latency):
    provider = 3 * 60000
    # At our old 5-second scheduler boundary, a fast local clock must not ask
    # the provider for its still-future next minute.
    local = provider + 5000 + lead
    assert live.confirmation_cutoff(local) <= provider + latency


@pytest.mark.parametrize('code,body,reason', [
    (400, {"errorMessage": "Invalid value specified for 'to'. Time is in the future"}, 'TIME_BOUNDARY'),
    (400, {"errorMessage": "secret unrelated error"}, 'UNKNOWN'),
    (401, {}, 'AUTH'), (403, {}, 'AUTH'), (429, {}, 'RATE_LIMIT'), (504, {}, 'GATEWAY')])
def test_safe_request_reason_is_specific_and_never_contains_supplier_text(code, body, reason):
    response = httpx.Response(code, json=body, request=httpx.Request('GET', 'https://private.invalid/token'))
    error = httpx.HTTPStatusError('secret account token', request=response.request, response=response)
    result = failed_request(error, observed_at=125000)
    assert result.reason_code == reason
    assert not any(text in result.model_dump_json() for text in ('secret', 'private.invalid', 'token'))
    if reason == 'TIME_BOUNDARY':
        assert result.retry_at == 130000 and not result.successful


def test_confirmation_and_sampling_recover_only_their_own_operation(running, monkeypatch):
    factory, ownership, epoch, identities = running
    identity = identities['EUR_USD']
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    failed = candles(identity, rows=(), result=RequestResult(status='timeout', operation='candles',
        window_start=0, window_end=120000))
    live.commit_confirmation(ownership, epoch, failed, now=126000)
    with factory() as db:
        state = db.get(LiveState, identity.key)
        assert state.error is None and state.ready and health(db, state)['error'] == 'timeout'
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=2, source=127000), identities, now=128000)
    live.commit_confirmation(ownership, epoch, candles(identity), now=128000, operation='candles_latest')
    with factory() as db:
        assert health(db, db.get(LiveState, identity.key))['error'] == 'timeout'
    state = next(row for row in live.snapshots(now=128000) if row['dataset_id'] == identity.key)
    assert state['quote_ready'] and state['connection_error'] is None and state['confirmation_error'] == 'timeout'
    assert not state['candle_ready']
    with factory.begin() as db:
        db.get(LiveState, identity.key).error = 'unavailable'
    live.commit_confirmation(ownership, epoch, candles(identity), now=129000)
    with factory() as db:
        state = db.get(LiveState, identity.key)
        assert health(db, state)['error'] is None and state.error == 'unavailable'


def test_future_rejection_retains_cursor_and_bounded_retry(running):
    factory, ownership, epoch, identities = running
    identity=identities['EUR_USD']
    failed=candles(identity,rows=(),checkpoint=0,result=RequestResult(status='unavailable',reason_code='TIME_BOUNDARY',
        retry_at=140000,window_start=0,window_end=120000))
    live.commit_confirmation(ownership,epoch,failed,now=135000)
    with factory() as db:
        state=db.get(LiveState,identity.key)
        assert state.confirmed_end==0 and state.recovery_cursor==0 and state.next_confirm_at==140000
    assert live.confirmation_window(ownership,epoch,identity,now=139999) is None
    assert live.confirmation_window(ownership,epoch,identity,now=140000)==(0,120000)
    live.commit_confirmation(ownership,epoch,candles(identity),now=140000)
    with factory() as db:
        assert not health(db,db.get(LiveState,identity.key))['open']


def test_legacy_names_batch_search_changes_and_snapshot_survive_registry_loss(database,monkeypatch):
    from alerts.composite_definitions import first_use
    from alerts.series_access import composite_definition,search
    from alerts.notice_instruments import capture,enrich
    fixture(database,monkeypatch)
    with database.begin() as db:
        candidate=search(db,'EURUSD',kind='composite')[0]
        dataset,mapping,_=composite_definition(db,candidate['id'])
        composite=first_use(db,dataset,mapping)
        state=center.stream(db,lock=True)
        original_cursor=center._cursor(state,{'kind':'changes','seq':state.seq})
        for n in range(3):
            body={'title':'共享行情读取失败','context':{'instrument':composite.id,'series_kind':'composite','timeframe':'quotes'}}
            if n==2:body['instrument_display']=capture(db,body)
            center._new_event(db,state,ident='legacy:'+str(n),source_kind='market',source_id='source:'+str(n),
                occurred_at=now_ms()+n,body=body,dedupe=str(n))
    with database() as db:
        before=[(row.id,row.body,row.viewed_at) for row in db.scalars(select(NoticeEvent))]
        for term in ['EURUSD','eurusd','EUR/USD']:
            first=center.list_events(db,center.SUBJECT,{'q':term},limit=1)
            second=center.list_events(db,center.SUBJECT,{'q':term},before=first['before'],limit=2)
            assert len(first['events'])==1 and len(second['events'])==2
            assert first['events'][0]['instrument_display']['symbol']=='EURUSD'
        detail=center.detail(db,center.SUBJECT,'legacy:0')
        assert detail['instrument_display']['provenance']=='resolved_current'
        assert detail['instrument']==composite.id and detail['context']['timeframe']=='quotes'
        changes=center.changes(db,center.SUBJECT,original_cursor)
        assert all(row['body']['instrument_display']['symbol']=='EURUSD' for row in changes['changes'])
        assert [(row.id,row.body,row.viewed_at) for row in db.scalars(select(NoticeEvent))]==before
        assert enrich(db,[{'instrument':composite.id}],subject='other')[0].get('instrument_display') is None
    # A registry permission change never leaks a resolved name to old records;
    # the new event's own snapshot remains a historical fact.
    with database.begin() as db:
        db.execute(MarketComposite.__table__.update().where(MarketComposite.id==composite.id).values(permission_scope='private:other'))
    with database() as db:
        assert 'instrument_display' not in center.detail(db,center.SUBJECT,'legacy:0') or center.detail(db,center.SUBJECT,'legacy:0')['instrument_display'] is None
        assert center.detail(db,center.SUBJECT,'legacy:2')['instrument_display']['provenance']=='event_snapshot'


def test_full_100_record_name_page_is_batched(database,monkeypatch):
    from alerts.notice_instruments import enrich
    from alerts.series_access import search,composite_definition
    from alerts.composite_definitions import first_use
    fixture(database,monkeypatch)
    with database.begin() as db:
        candidate=search(db,'EURUSD',kind='composite')[0]
        dataset,mapping,_=composite_definition(db,candidate['id']);composite=first_use(db,dataset,mapping)
    statements=[]
    with database() as db:
        def count(*args):statements.append(args[2])
        event.listen(db.bind,'before_cursor_execute',count)
        try:rows=enrich(db,[{'instrument':composite.id,'context':{'series_kind':'composite'}} for _ in range(100)])
        finally:event.remove(db.bind,'before_cursor_execute',count)
        assert len(rows)==100 and all(row['instrument_display']['symbol']=='EURUSD' for row in rows)
        assert len(statements)==1


def test_sampling_evidence_is_safe_epoch_fenced_and_independent(running):
    from alerts.live_confirmation import sampling_evidence
    factory, ownership, epoch, identities = running
    identity = identities['EUR_USD']
    failed = RequestResult(status='timeout', operation='candles_latest', reason_code='TIMEOUT', phase='read')
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        sampling_evidence(db, state, result=failed)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        assert sampling_evidence(db, state)['operation'] == 'candles_latest'
        assert not health(db, state)
        state.epoch += 1
        assert not sampling_evidence(db, state)
        sampling_evidence(db, state, result=RequestResult(status='data'))
    with factory() as db:
        assert not sampling_evidence(db, db.get(LiveState, identity.key))
