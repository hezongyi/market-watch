import pytest
from alerts import native_history_loads as loads
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.chart_api import DataQuery
from alerts.config import settings
from alerts.storage import NativeHistoryLoad
from test_provider_cache import META, page, seed


def body(count=24000, **kwargs):
    return DataQuery(instrument=META['id'], series_kind='provider', timeframe='M5',
                     before=40000000, limit=count, countBack=count,
                     native_history={'chart_count': 4}, **kwargs)


@pytest.fixture
def history(database, monkeypatch):
    monkeypatch.setattr(settings, 'native_history_max_bars', 80000)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda m, f, b, n, **k: page(b-n*1000,b))
    return database


def test_cold_task_progress_final_snapshot_hot_reuse_and_idempotency(history):
    submitted = loads.submit('owner', 'request', body())
    ident = submitted['load']['id']
    assert loads.submit('owner', 'request', body())['load']['id'] == ident
    for expected in range(1, 7):
        assert loads.once()
        state = loads.status('owner', ident)
        assert state['pages'] == expected
    assert state['state'] == 'ready'
    result = loads.result('owner', ident)['result']
    assert len(result['bars']) == 24000 and result['cache_hit']
    assert len(loads.submit('owner', 'hot', body())['result']['bars']) == 24000
    with pytest.raises(Exception) as exc:
        loads.status('another-owner', ident)
    assert exc.value.status_code == 404


def test_cancel_one_consumer_preserves_other_and_committed_pages(history):
    first = loads.submit('one', 'r', body())['load']['id']
    second = loads.submit('two', 'r', body())['load']['id']
    loads.once()
    assert loads.status('one', first, True)['state'] == 'cancelled'
    assert loads.status('one', first, True)['state'] == 'cancelled'
    for _ in range(6):
        loads.once()
    assert loads.status('two', second)['state'] == 'ready'
    assert len(loads.result('two', second)['result']['bars']) == 24000


def test_expiry_and_worker_restart_reuse_committed_pages(history):
    ident = loads.submit('owner', 'r', body())['load']['id']
    loads.once()
    with history.begin() as db:
        row = db.get(NativeHistoryLoad, ident)
        row.state = 'filling'
        row.lease_until = 0  # simulate process exit and execution lease expiry
    loads.once()
    assert loads.status('owner', ident)['pages'] == 2
    with history.begin() as db:
        db.get(NativeHistoryLoad, ident).consumer_until = 0
    assert not loads.once()
    assert loads.status('owner', ident)['state'] == 'expired'
    key = cache.identity(META, 'M5')
    assert len(cache.snapshot(key,40000000,10000)['bars']) == 8000


def test_ready_result_reads_new_revision(history):
    seed(META, 'M5', 40000000, page(16000000,40000000))
    with history.begin() as db:
        db.add(NativeHistoryLoad(id='ready',owner='owner',request_id='r',query_json=body().model_dump(by_alias=True),
            state='ready',deadline=cache.now_ms()+60000,consumer_until=cache.now_ms()+45000))
    original = loads.result('owner','ready')['result']
    seed(META,'M5',16001000,page(16000000,16001000,close='4'))
    latest = loads.result('owner','ready')['result']
    assert latest['cache_revision'] > original['cache_revision']
    assert latest['bars'][0]['close'] == '4'


def test_budget_and_overlapping_id_conflict(history, monkeypatch):
    with pytest.raises(loads.CapacityExceeded):
        loads.submit('owner','large',body(80001))
    loads.submit('owner','r',body())
    with pytest.raises(Exception) as exc:
        loads.submit('owner','r',body(25000))
    assert exc.value.status_code == 409
    monkeypatch.setattr(settings,'native_history_tasks_per_owner',1)
    with pytest.raises(Exception) as exc:
        loads.submit('owner','second',body())
    assert exc.value.status_code == 503


def test_cancel_during_upstream_fences_uncommitted_page(history, monkeypatch):
    ident = loads.submit('owner','r',body())['load']['id']
    def fetch(m,f,b,n,**k):
        loads.status('owner',ident,True)
        return page(b-n*1000,b)
    monkeypatch.setattr(upstream,'native_page',fetch)
    loads.once()
    assert loads.status('owner',ident)['state'] == 'cancelled'
    assert cache.snapshot(cache.identity(META,'M5'),40000000,10)['bars'] == []
