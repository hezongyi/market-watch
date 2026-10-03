import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.chart_api import DataQuery
from test_provider_cache import META, page, seed


def reserve(**kwargs):
    return DataQuery(instrument=META['id'], series_kind='provider', timeframe='M5',
                     before=1000000, countBack=131, limit=131,
                     native_history={'chart_count': 4, 'focused': False},
                     native_reserve={'screen_bars': 131, 'batch_screens': 1}, **kwargs)


def test_reserve_is_pg_only_even_for_visible_nonfocused_chart(database, monkeypatch):
    seed(META, 'M5', 1000000, page(0, 1000000, boundary=True))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('reserve fetched upstream'))
    result = cache.data(reserve())
    assert result['reserve_status'] == 'ready'
    assert len(result['bars']) == 131
    assert result['mandatory_count'] == 0
    assert not result['history_boundary']
    assert result['bars'][0]['chart_time'] == 869000


def test_partial_reserve_and_gap_do_not_claim_end_of_history(database, monkeypatch):
    seed(META, 'M5', 1000000, page(980000, 1000000))
    seed(META, 'M5', 900000, page(800000, 900000))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('optional miss fetched'))
    result = cache.data(reserve())
    assert len(result['bars']) == 20 and result['reserve_status'] == 'partial'
    assert not result['history_boundary']
    assert result['bars'][0]['chart_time'] == 980000


def test_reserve_miss_activates_existing_bounded_warming(database, monkeypatch):
    from alerts import provider_service as service
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('miss fetched'))
    activated = []
    monkeypatch.setattr(service, 'activate', lambda *a, **k: activated.append((a, k)))
    result = cache.data(reserve(client='reserve-test'))
    assert result['bars'] == [] and result['reserve_status'] == 'miss'
    assert not result['history_boundary']
    assert len(activated) == 1 and activated[0][0][3] == 131


def test_reserve_confirmed_boundary_and_server_batch_limit(database, monkeypatch):
    seed(META, 'M5', 1000000, page(980000, 1000000, boundary=True))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    result = cache.data(reserve())
    assert len(result['bars']) == 20 and result['history_boundary']
    body = reserve().model_copy(update={'count_back': 10000})
    result = cache.data(body)
    assert result['reserve_requested_count'] == 131


def test_reserve_warmup_is_separately_bounded(database, monkeypatch):
    seed(META, 'M5', 1000000, page(0, 1000000, boundary=True))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('warmup fetched upstream'))
    body = reserve().model_dump(by_alias=True)
    body['native_reserve']['warmup_bars'] = 200
    result = cache.data(DataQuery.model_validate(body))
    assert result['reserve_requested_count'] == 331 and len(result['bars']) == 331
    body['native_reserve']['warmup_bars'] = 2001
    with pytest.raises(ValueError):
        DataQuery.model_validate(body)


@pytest.mark.parametrize('extra', [
    {'screen_bars': True, 'batch_screens': 1},
    {'screen_bars': 2001, 'batch_screens': 1},
    {'screen_bars': 131, 'batch_screens': 3},
    {'screen_bars': 131, 'batch_screens': 1, 'force': True},
])
def test_reserve_rejects_invalid_context(extra):
    with pytest.raises(ValueError):
        DataQuery(instrument=META['id'], series_kind='provider', timeframe='M5',
                  native_history={'chart_count': 1}, native_reserve=extra)


def test_reserve_rejects_python_and_missing_native_context():
    for updates in ({'indicators': [{'name': 'SMA'}]}, {'native_history': None},
                    {'history_observation': {'revision': 0, 'observed_at': 0, 'first': 0, 'last': 0}}):
        body = reserve().model_dump(by_alias=True)
        body.update(updates)
        with pytest.raises(ValueError):
            DataQuery.model_validate(body)


def test_reserve_http_contract_and_auth(database, monkeypatch):
    from alerts import api as api_module
    from fastapi.testclient import TestClient

    seed(META, 'M5', 1000000, page(0, 1000000, boundary=True))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('HTTP reserve fetched upstream'))
    query = reserve().model_dump(by_alias=True)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'
    try:
        with TestClient(api_module.app) as client:
            response = client.post('/api/charts/reserve', json=query)
            assert response.status_code == 200
            result = response.json()
            assert result['reserve_status'] == 'ready'
            assert result['mandatory_count'] == 0 and len(result['bars']) == 131
            assert result['candles_http_attempts'] == []
            # An old bridge cannot accidentally use the new lane as an ordinary
            # mandatory request. Neither invalid case may enter provider I/O.
            missing = {k: v for k, v in query.items() if k != 'native_reserve'}
            assert client.post('/api/charts/reserve', json=missing).status_code == 422
            assert client.post('/api/charts/reserve', json={**query, 'series_kind': 'managed'}).status_code == 422
    finally:
        api_module.app.dependency_overrides.clear()
    with TestClient(api_module.app) as client:
        assert client.post('/api/charts/reserve', json=query).status_code == 401
