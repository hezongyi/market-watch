import json
import logging
import time

import pytest
from alerts import native_history_loads as loads
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.chart_query import DataQuery
from alerts.config import settings
from alerts.storage import NativeHistoryLoad
from sqlalchemy import event
from sqlalchemy.exc import DBAPIError
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


def test_worker_only_prepares_coverage_and_api_publishes_final_snapshot(history, monkeypatch):
    from alerts import provider_display_snapshots

    published = []
    original = provider_display_snapshots.publish
    monkeypatch.setattr(provider_display_snapshots, 'publish', lambda page: published.append(page))
    ident = loads.submit('owner', 'coverage-only', body(4000))['load']['id']
    loads.once()
    assert loads.status('owner', ident)['state'] == 'ready'
    assert published == [], 'worker must not construct and discard a final display response'
    monkeypatch.setattr(provider_display_snapshots, 'publish', original)
    result = loads.result('owner', ident)['result']
    assert len(result['bars']) == 4000 and result['provider_snapshot_id']


def test_received_page_has_bounded_completion_budget_without_second_fetch(history, monkeypatch):
    calls = []
    original = upstream.native_page
    monkeypatch.setattr(loads, 'request_seconds', lambda source: 0.2)

    def received_page(*args, **kwargs):
        calls.append(1)
        time.sleep(0.25)  # A valid response finishes parsing at the I/O boundary.
        return original(*args, **kwargs)

    monkeypatch.setattr(upstream, 'native_page', received_page)
    ident = loads.submit('owner', 'io-boundary', body(4000))['load']['id']
    loads.once()
    assert loads.status('owner', ident)['state'] == 'ready'
    assert len(loads.result('owner', ident)['result']['bars']) == 4000
    assert calls == [1]


def test_completion_budget_never_commits_a_cancelled_consumer(history, monkeypatch):
    ident = loads.submit('owner', 'cancel-before-commit', body(4000))['load']['id']
    original = upstream.native_page

    def cancelled_page(*args, **kwargs):
        result = original(*args, **kwargs)
        loads.status('owner', ident, True)
        return result

    monkeypatch.setattr(upstream, 'native_page', cancelled_page)
    loads.once()
    assert loads.status('owner', ident)['state'] == 'cancelled'
    assert cache.snapshot(cache.identity(META, 'M5'), 40000000, 4000)['bars'] == []


def test_result_poll_preserves_progress_and_final_page_count(history):
    from alerts.provider_history_policy import capabilities

    assert capabilities()['result_polling'] is True
    ident = loads.submit('owner', 'result-poll', body(8000))['load']['id']
    assert loads.result('owner', ident)['load']['state'] == 'waiting'
    loads.once()
    pending = loads.result('owner', ident)
    assert pending['load']['pages'] == 1 and 'result' not in pending
    loads.once()
    ready = loads.result('owner', ident)
    assert ready['load']['id'] == ident and ready['load']['state'] == 'ready'
    assert ready['load']['pages'] == 2 and len(ready['result']['bars']) == 8000


def test_pending_turn_retains_fill_timings_and_final_result_contract(history, caplog, monkeypatch):
    original = upstream.native_page

    def timed_page(*args, **kwargs):
        started = cache.time.monotonic()
        value = original(*args, **kwargs)
        upstream.record_timing('upstream_http', started)
        return value

    monkeypatch.setattr(upstream, 'native_page', timed_page)
    caplog.set_level(logging.INFO, logger=loads.__name__)
    ident = loads.submit('owner', 'timed-pages', body(8000))['load']['id']
    loads.once()
    turn = json.loads(next(record.message.split('native-history-turn ', 1)[1]
                           for record in caplog.records if record.message.startswith('native-history-turn ')))
    assert turn['id'] == ident and turn['state'] == 'waiting' and turn['committed']
    assert turn['pages'] == 1 and turn['finished_at'] >= turn['claimed_at'] >= turn['created_at']
    assert all(turn[key] >= 0 for key in ('claim_ms', 'fill_ms', 'persist_ms'))
    assert all(turn['timings_ms'][key] >= 0 for key in ('read_total', 'upstream_http', 'lease_wait', 'database_commit'))
    assert 'owner' not in turn and 'query' not in turn
    loads.once()
    result = loads.result('owner', ident)['result']
    assert len(result['bars']) == 8000 and result['cache_hit']
    assert 'timings_ms' in result and 'history_trace' not in result


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


def test_page_budget_allows_ready_at_exact_last_page(history, monkeypatch):
    monkeypatch.setattr(settings, 'native_history_task_pages', 8)
    ident = loads.submit('owner', 'exact-page-limit', body(32000))['load']['id']
    for _ in range(9):
        loads.once()
    assert loads.status('owner', ident)['state'] == 'ready'
    assert loads.status('owner', ident)['pages'] == 8


def test_independent_demands_get_fair_page_turns(history, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda instrument:
        {**META, 'symbol': 'OTHER', 'id': 'OTHER'} if instrument == 'OTHER' else META)
    one = loads.submit('one', 'long', body())['load']['id']
    other = body().model_copy(update={'instrument': 'OTHER'})
    two = loads.submit('two', 'short', other)['load']['id']
    loads.once()
    loads.once()
    assert loads.status('one', one)['pages'] == 1
    assert loads.status('two', two)['pages'] == 1
    assert cache.identity(META, 'M5') != cache.identity({**META, 'symbol': 'OTHER'}, 'M5')


def test_shared_source_acquisition_busy_waits_then_completes(history, monkeypatch):
    from alerts.source_history_store import AcquisitionBusy

    ident = loads.submit('owner', 'source-busy', body(4000))['load']['id']
    original = upstream.native_page
    def busy(*args, **kwargs):
        raise AcquisitionBusy('source_page_in_progress')
    monkeypatch.setattr(upstream, 'native_page', busy)
    loads.once()
    assert loads.status('owner', ident)['state'] == 'waiting'
    with history.begin() as db:
        row = db.get(NativeHistoryLoad, ident)
        assert row.stalls == 0 and row.error_json is None
        row.lease_until = 0  # Advance the retry without sleeping in the test.
    monkeypatch.setattr(upstream, 'native_page', original)
    loads.once()
    assert loads.status('owner', ident)['state'] == 'ready'
    assert len(loads.result('owner', ident)['result']['bars']) == 4000


@pytest.mark.parametrize('instrument', ['AKSHARE:fixture', 'TENCENT:SZSE:000001'])
def test_akshare_native_task_uses_source_request_budget(history, monkeypatch, instrument):
    sources = []
    monkeypatch.setattr(loads, 'request_seconds', lambda source: sources.append(source) or 30)
    loads.submit('owner', 'source-budget', body(4000).model_copy(update={'instrument': instrument}))
    loads.once()
    assert sources == ['akshare']


@pytest.mark.parametrize('latest', [False, True])
def test_successful_empty_pages_fail_after_bounded_no_progress(history, monkeypatch, latest):
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: {'bars': [], 'history_boundary': False})
    query = body().model_copy(update={'before': None}) if latest else body()
    ident = loads.submit('owner', 'empty-pages', query)['load']['id']
    for _ in range(3):
        loads.once()
    state = loads.status('owner', ident)
    assert state['state'] == 'failed' and state['pages'] == 3
    assert state['error']['code'] == 'HISTORY_NO_PROGRESS'


@pytest.mark.parametrize("sqlstate", ["57014", "55P03"])
def test_snapshot_database_timeout_is_structured_and_next_request_recovers(history, sqlstate):
    from alerts import api as api_module
    from fastapi.testclient import TestClient

    class DatabaseTimeout(Exception):
        pass

    original = DatabaseTimeout("fixture database timeout")
    original.sqlstate = sqlstate
    engine = history.kw["bind"]
    seed(META, "M5", 40000000, page(39990000, 40000000))

    def interrupt_snapshot(conn, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith("SELECT") and "provider_bars" in statement:
            raise DBAPIError(statement, parameters, original)

    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app, raise_server_exceptions=False) as client:
            event.listen(engine, "before_cursor_execute", interrupt_snapshot)
            try:
                response = client.post("/api/charts/history-loads", json={
                    "request_id": "snapshot-timeout", "query": body(5).model_dump(by_alias=True),
                })
                assert response.status_code == 503
                assert response.json()["detail"]["code"] == "HISTORY_TIMEOUT"
                assert response.json()["detail"]["history_boundary"] is False
            finally:
                event.remove(engine, "before_cursor_execute", interrupt_snapshot)
            recovered = client.post("/api/charts/history-loads", json={
                "request_id": "after-timeout", "query": body(5).model_dump(by_alias=True),
            })
            assert recovered.status_code == 200
            assert len(recovered.json()["result"]["bars"]) >= 5
            assert recovered.json()["result"]["bars"][-1]["chart_time"] == 39999000
    finally:
        api_module.app.dependency_overrides.clear()


def startup_body():
    return DataQuery(instrument=META['id'], series_kind='provider', timeframe='M5',
                     limit=1, countBack=1, firstDataRequest=True,
                     native_history={'chart_count': 1, 'focused': True})


def test_startup_preparation_commits_once_and_real_demand_reads_prices(history, monkeypatch):
    calls = []
    monkeypatch.setattr(upstream, 'native_page', lambda m,f,b,n,**k:
        calls.append(1) or page(b-(n+k.get('optional',0))*1000,b))
    query = startup_body()
    ident = loads.submit('owner', 'startup', query, prepare=True)['load']['id']
    assert loads.submit('owner', 'startup', query, prepare=True)['load']['id'] == ident
    with pytest.raises(Exception) as exc:
        loads.submit('owner', 'startup', query)
    assert exc.value.status_code == 409
    loads.once()
    result = loads.result('owner', ident)['result']
    assert result['prepared'] is True and 'bars' not in result and 'provider_snapshot_id' not in result
    actual = loads.submit('owner', 'actual', query.model_copy(update={'limit':200, 'count_back':200}))['result']
    assert len(actual['bars']) == 2000 and actual['provider_snapshot_id']
    assert calls == [1]


@pytest.mark.parametrize('disabled', ['setting', 'global', 'queued-setting'])
def test_disabled_preparation_does_not_fetch_or_expand(history, monkeypatch, disabled):
    from alerts import provider_history_policy as policy
    from alerts.storage import ProviderDataset
    from sqlalchemy import func, select
    query = startup_body()
    ident = None
    if disabled == 'queued-setting':
        ident = loads.submit('owner', 'startup', query, prepare=True)['load']['id']
    if disabled in ('setting', 'queued-setting'):
        values = policy.prefetch_capabilities()['sources']
        values['oanda'] = {'initial_bars':0, 'reserve_bars':0}
        policy.save_prefetch(values)
    elif disabled == 'global':
        monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    else:
        monkeypatch.setattr(upstream, 'metadata', lambda _: {**META, 'source':'binance'})
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('disabled optional work fetched prices'))
    if ident:
        loads.once()
        result = loads.result('owner', ident)['result']
    else:
        result = loads.submit('owner', 'startup', query, prepare=True)['result']
        with history.begin() as db:
            assert db.scalar(select(func.count()).select_from(ProviderDataset)) == 0
    assert result == {'prepared':False}


def test_preparation_rejects_real_demands(history):
    with pytest.raises(Exception) as exc:
        loads.submit('owner', 'invalid-startup', body(), prepare=True)
    assert exc.value.status_code == 422


@pytest.mark.parametrize('instrument,source', [('YAHOO:AAPL','yahoo'), ('MWP:YAHOO:AAPL','yahoo'), ('OANDA:EUR_USD','oanda'), ('NATIVE:configured','oanda')])
def test_worker_uses_central_source_budget(history, monkeypatch, instrument, source):
    sources = []
    monkeypatch.setattr(loads, 'request_seconds', lambda value: sources.append(value) or 30)
    loads.submit('owner', 'central-budget', body(4000).model_copy(update={'instrument':instrument}))
    loads.once()
    assert sources == [source]


def test_worker_coverage_preserves_real_range_and_indicator_prefix(history, monkeypatch):
    from alerts.chart_indicators import history_requirement
    from test_provider_indicator_inputs import stable_indicators
    spec = {'name':'EMA', 'params':{'period':20}}
    query = body(200, indicators=[spec]).model_copy(update={'from_time':39500000})
    calls = []
    monkeypatch.setattr(upstream, 'native_page', lambda m,f,b,n,**k: calls.append(n) or page(b-n*1000,b))
    ident = loads.submit('owner','range-prefix',query)['load']['id']
    for _ in range(3):
        loads.once()
        if loads.status('owner',ident)['state']=='ready':
            break
    result = loads.result('owner',ident)['result']
    direct = cache.data(query)
    assert len(result['bars']) == 500
    assert sum(calls) >= 500 + history_requirement(spec)
    assert result['bars'] == direct['bars']
    assert stable_indicators(result) == stable_indicators(direct)


@pytest.mark.parametrize('source,prefix', [('oanda','OANDA'),('binance','BINANCE'),('dukascopy','DUKA'),('yahoo','YAHOO'),('akshare','AKSHARE'),('fxcm','FXCM')])
def test_all_sources_prepare_once_and_reuse_prices(history, monkeypatch, source, prefix):
    meta = {**META, 'source':source, 'id':prefix+':sample',
            'adjustment':'supplier', 'source_family':'sina'}
    if source == 'fxcm':
        meta['account_scope'] = 'fixture'
    monkeypatch.setattr(upstream, 'metadata', lambda *a, **k: meta)
    calls = []
    monkeypatch.setattr(upstream, 'native_page', lambda m,f,b,n,**k:
        calls.append(n+k.get('optional',0)) or page(b-(n+k.get('optional',0))*1000,b))
    query = startup_body().model_copy(update={'instrument':meta['id']})
    ident = loads.submit('owner','all-source-startup',query,prepare=True)['load']['id']
    loads.once()
    assert loads.result('owner',ident)['result']['prepared'] is True
    actual = loads.submit('owner','real-demand',query.model_copy(update={'limit':20,'count_back':20}))['result']
    assert len(actual['bars']) >= 20
    assert len(calls) == 1


def test_disabled_preparation_skips_remote_metadata(history, monkeypatch):
    from alerts import provider_history_policy as policy
    values = policy.prefetch_capabilities()['sources']
    values['yahoo'] = {'initial_bars':0,'reserve_bars':0}
    policy.save_prefetch(values)
    monkeypatch.setattr(upstream,'metadata',lambda *a,**k: pytest.fail('disabled preparation resolved remote metadata'))
    query = startup_body().model_copy(update={'instrument':'YAHOO:AAPL'})
    assert loads.submit('owner','disabled-yahoo',query,prepare=True) == {'result':{'prepared':False}}


def test_upstream_timeout_without_progress_is_terminal(history, monkeypatch):
    ident = loads.submit('owner','timeout-no-progress',body(4000).model_copy(update={'instrument':'FXCM:sample'}))['load']['id']
    monkeypatch.setattr(upstream,'native_page',lambda *a,**k: (_ for _ in ()).throw(TimeoutError('budget expired')))
    loads.once()
    result = loads.status('owner',ident)
    assert result['state'] == 'failed'
    assert result['error']['code'] == 'HISTORY_TIMEOUT'
    assert result['error']['history_boundary'] is False
