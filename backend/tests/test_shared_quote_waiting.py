"""Replay the real shared-cache quote path through durable source notices."""
import pytest
from alerts import market_notices as notices
from alerts import market_stream as stream
from alerts import notification_center as center
from alerts import provider_cache as cache
from alerts import provider_chart as provider
from alerts import storage
from alerts.config import settings
from alerts.market_data import QuoteQuery, quote_snapshot
from alerts.storage import (
    NoticeEvent,
    NoticeIncident,
    ProviderBar,
    ProviderDataset,
    ProviderInterest,
)
from sqlalchemy import select
from test_market_notices import publish, register
from test_market_stream import session
from test_notification_center import drain
from test_provider_cache import META, page


@pytest.fixture
def waiting(database, monkeypatch):
    from alerts import market_stream_worker
    clock = [storage.now_ms() // 60000 * 60000 + 30000]
    for module in (storage, cache, provider, stream, notices, center, market_stream_worker):
        monkeypatch.setattr(module, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'rest_batch')
    monkeypatch.setattr(settings, 'oanda_account_id', 'waiting-test-account')
    monkeypatch.setattr(settings, 'provider_fresh_seconds', 15)
    monkeypatch.setattr(provider, 'metadata', lambda *a, **kw: {**META, 'name':'EURUSD'})
    monkeypatch.setattr(provider, 'quote_previous_close', lambda *_: None)
    monkeypatch.setattr(provider, 'native_page', lambda *a, **kw: pytest.fail('shared wait cannot poll upstream'))
    provider._QUOTE_LAST.clear()
    key = cache.ensure(META, 'M1')
    lease = cache.claim(key)
    cache.commit_page(key, lease, page(clock[0]-90000, clock[0], close='1.12224'),
                      clock[0]+1, clock[0]-16000, latest=True)
    cache.release(key, lease)
    with database.begin() as db:
        db.add(ProviderInterest(id='waiting-interest', client='waiting-client', listener='quote',
            dataset_id=key, accessed_at=clock[0], subscribed=True, expires=clock[0]+300000))
    owner = session(database)
    register(owner)
    register(owner, 'second')
    yield clock, key
    provider._QUOTE_LAST.clear()


def quote():
    return {'type':'quotes', 'quotes':quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']]))}


def test_stale_cache_retains_price_without_failure_or_fake_recovery(database, waiting):
    result = quote()
    value = result['quotes'][0]['v']
    assert value['lp'] == 1.12224
    assert value['fetch_status'] == 'stale'
    assert value['cache_age_ms'] == 16000
    assert value['last_success_at'] == waiting[0][0]-16000
    assert value['wait_reason'] == 'shared_refresh'
    assert notices.result_state(result) == 'waiting'
    publish(database, result)
    with database() as db:
        assert not list(db.scalars(select(NoticeEvent)))
    # A real transport failure remains open through a pending cached read.
    publish(database, {'type':'quotes','quotes':[{'s':'error','v':{
        'fetch_status':'fetch_failed','error_evidence':{'error_type':'ConnectTimeout','stage':'timeout'}}}]})
    publish(database, quote())
    with database() as db:
        assert db.scalar(select(NoticeIncident)).closed_at is None


def test_persistent_wait_escalates_once_per_shared_task_and_recovers_on_new_read(database, waiting):
    clock, key = waiting
    publish(database, quote())
    clock[0] += 31000
    publish(database, quote())
    with database() as db:
        rows = list(db.scalars(select(NoticeEvent)))
        assert len(rows) == 1
        assert rows[0].body['evidence']['error']['error_type'] == 'SharedQuoteWaitTimeout'
        assert rows[0].body['evidence']['affected_subscriptions'] == 2
        incident = rows[0].incident_id
    clock[0] += 2000
    publish(database, quote())
    with database() as db:
        assert len(list(db.scalars(select(NoticeIncident)))) == 1
        assert db.get(NoticeIncident, incident).closed_at is None
    # Merely delivering cached data did not recover. A new collector commit does.
    lease = cache.claim(key)
    cache.commit_page(key, lease, page(clock[0]-90000, clock[0], close='1.12345'),
                      clock[0]+1, clock[0], latest=True)
    cache.release(key, lease)
    publish(database, quote())
    drain(database)
    with database() as db:
        assert db.get(NoticeIncident, incident).closed_at is not None


def test_waiting_quote_text_does_not_claim_update_failure():
    from alerts.quote_presentation import describe
    assert '等待首次报价' in describe({'fetch_status':'pending'})['description']
    value = describe({'lp':1.1,'fetch_status':'stale'})
    assert '暂未更新' in value['description']
    assert '更新失败' not in value['description']


def test_empty_cache_is_pending_and_canceling_observation_restarts_grace(database, waiting):
    from sqlalchemy import delete
    clock, key = waiting
    with database.begin() as db:
        db.execute(delete(ProviderBar).where(ProviderBar.dataset_id == key))
        db.get(ProviderDataset, key).latest_at = 0
    result = quote()
    value = result['quotes'][0]['v']
    assert 'lp' not in value
    assert value['fetch_status'] == 'pending' and value['wait_reason'] == 'first_quote'
    publish(database, result)
    clock[0] += 20000
    stream.cancel('session', 'page', 'quote', 1)
    stream.cancel('session', 'second', 'quote', 1)
    register('session', generation=2)
    clock[0] += 15000
    publish(database, quote())
    with database() as db:
        assert not list(db.scalars(select(NoticeEvent))), 'ended waiting is not an active outage'


def test_pending_worker_rechecks_only_cache_with_bounded_delay(database, waiting):
    from alerts.chart_api import DataQuery
    from alerts.market_stream_worker import Calculator
    from alerts.provider_cache import identity
    work = {'id':'a'*64, 'query':DataQuery(instrument=META['id'],series_kind='provider',
        timeframe='M1').model_dump(), 'identity':{'kind':'quotes','metadata':META,
        'dataset_id':identity(META,'M1')}}
    # Existing fixture demand owns the shared cache; renew/subscribe add only
    # consumer interests and never call native_page (guarded by the fixture).
    payload, delay = Calculator().build(work)
    assert payload['quotes'][0]['v']['fetch_status'] == 'stale'
    assert 2000 <= delay <= 2500
    from alerts.storage import Preference
    with database.begin() as db:
        db.add(Preference(key='notice:market-stream:'+work['id'],
                          value={'waiting_since':waiting[0][0]-31000}))
    _, delay = Calculator().build(work)
    assert delay == 15000, 'persistent waits return to normal cadence'
