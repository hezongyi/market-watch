"""Read-only composite MCP/browser parity and no demand side effects."""

from alerts.composite_definitions import first_use, save_mapping
from alerts.storage import MarketDemand
from sqlalchemy import select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity
from test_native_mcp import call, rpc
from test_native_mcp import mcp as mcp


def test_composite_mcp_matches_browser_and_never_creates_live_demand(mcp, monkeypatch):
    client, token, factory = mcp
    catalog = prepare(factory, monkeypatch)
    publish(factory)
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: 165725000)
    monkeypatch.setattr("alerts.composite_quotes.now_ms", lambda: 165725000)
    with factory.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        ident = composite.id
    expected = {
        "composite_list": ({}, "/center/composites"),
        "composite_list_candidates": ({}, "/center/composite-candidates"),
        "composite_get_mappings": ({"dataset_id": identity().key}, f"/datasets/{identity().key}/mappings"),
        "composite_get": ({"composite_id": ident}, f"/composites/{ident}"),
        "composite_get_quote": ({"composite_id": ident}, f"/composites/{ident}/quote"),
        "composite_get_requests": ({"composite_id": ident}, f"/composites/{ident}/requests"),
        "composite_get_bars": ({"composite_id": ident, "before": 165600000, "count": 2},
                               f"/composites/{ident}/chart?before=165600000&count=2"),
    }
    tools = rpc(client, token, "tools/list").json()["result"]["tools"]
    for name, (args, path) in expected.items():
        assert next(tool for tool in tools if tool["name"] == name)["annotations"]["readOnlyHint"]
        result = call(client, token, name, args)
        assert not result["isError"], result
        assert result["structuredContent"] == client.get("/api/market-data" + path).json()
    invalid = call(client, token, "composite_get_bars", {"composite_id": ident, "count": 2001})
    assert invalid["isError"]
    for dataset_id, expected_count in ((identity().key, 1), ("0" * 64, 0)):
        args = {"dataset_id": dataset_id}
        listed = call(client, token, "composite_list", args)["structuredContent"]
        assert listed == client.get("/api/market-data/center/composites", params=args).json()
        assert listed["total"] == expected_count
    with factory.begin() as db:
        assert db.scalar(select(MarketDemand)) is None


def indicator_fixture(factory, monkeypatch):
    from test_composite_aggregates import drain as aggregates
    from test_composite_chart import populated

    ident, revision, seam = populated(factory, monkeypatch)
    aggregates(revision, 'M1')
    monkeypatch.setattr('alerts.series_access.now_ms', lambda: 200010000)
    return ident, revision, seam


def indicator_query(ident, **changes):
    return {'instrument': ident, 'series_kind': 'composite', 'timeframe': 'M1', 'limit': 20,
            'indicators': [{'name': 'EMA', 'params': {'period': 2}},
                           {'name': 'RSI', 'params': {'period': 2}}], **changes}


def test_indicator_discovery_and_composite_validation(mcp, monkeypatch):
    import json

    from alerts.storage import FixedIndicatorRun

    client, token, factory = mcp
    ident, revision, _ = indicator_fixture(factory, monkeypatch)
    tools = rpc(client, token, 'tools/list').json()['result']['tools']
    tool = next(t for t in tools if t['name'] == 'indicators_calculate')
    assert len(tools) == 31
    assert tool['inputSchema']['properties']['series_kind']['enum'] == ['managed', 'provider', 'composite']
    for field in ('composite_revision_id', 'input_revision', 'provisional'):
        assert field in tool['inputSchema']['properties']
    schema = json.dumps(tool['outputSchema'])
    for field in ('history_checksum', 'segments', 'time_closed', 'visible_complete',
                  'input_evidence', 'provider_snapshot_id', 'cache_revision', 'calculation_origin',
                  'dependency_origin', 'initialized'):
        assert field in schema
    query = indicator_query(ident)
    for changes in ({'published': True}, {'dataset_start': 0}, {'calculation_origin': 0},
                    {'input_revision': 1}, {'input_revision': -1, 'composite_revision_id': revision},
                    {'input_revision': True, 'composite_revision_id': revision},
                    {'input_revision': '1', 'composite_revision_id': revision},
                    {'input_revision': 1, 'composite_revision_id': revision, 'provisional': True},
                    {'series_kind': 'managed', 'composite_revision_id': revision},
                    {'series_kind': 'provider', 'input_revision': 0}, {'limit': 2001},
                    {'provider_snapshot_id': 'a' * 64}, {'display_snapshot_id': 'a' * 64},
                    {'run_id': 'a' * 64}, {'composite_revision_id': 'unknown'},
                    {'composite_revision_id': revision, 'input_revision': 999},
                    {'indicators': [query['indicators'][0], {'name': 'EMA', 'params': {'period': 0}}]}):
        result = call(client, token, 'indicators_calculate', query | changes)
        assert result['isError'] and result['structuredContent']['error']['code'] == 'INVALID_ARGUMENT', result
    with factory.begin() as db:
        assert db.scalar(select(FixedIndicatorRun)) is None
    for name in ('market_get_quote', 'market_get_bars'):
        result = call(client, token, name, {'instrument': ident, 'series_kind': 'composite'})
        assert result['isError'] and result['structuredContent']['error']['code'] == 'INVALID_ARGUMENT'
    result = call(client, token, 'indicators_calculate', indicator_query('0' * 64))
    assert result['structuredContent']['error']['code'] == 'DATA_UNAVAILABLE'
    result = call(client, token, 'indicators_calculate', query | {'instrument': 'MWC:' + ident, 'series_kind': 'managed'})
    assert result['structuredContent']['error']['code'] == 'INVALID_ARGUMENT'


def test_composite_indicators_cold_partial_retry_and_browser_parity(mcp, monkeypatch):
    from alerts.storage import FixedIndicatorRun, MarketComposite
    from test_fixed_indicators import drain

    client, token, factory = mcp
    ident, revision, _ = indicator_fixture(factory, monkeypatch)
    def forbidden(*args, **kwargs):
        raise AssertionError('MCP cannot create market demand or call a supplier')
    monkeypatch.setattr('alerts.market_data.renew_demand', forbidden)
    monkeypatch.setattr('alerts.provider_chart.data', forbidden)
    query = indicator_query(ident)
    first = call(client, token, 'indicators_calculate', query)
    assert not first['isError'], first
    page = first['structuredContent']['page']
    assert page['bars'] and len(page['indicators']) == 2 and page['pending']
    assert page['revision_id'] == revision and page['input_revision'] == 1
    for item in page['indicators']:
        calc = item['calculation']
        assert not calc['visible_complete'] and calc['calculation_origin'] == 0
        assert calc['input_evidence']['revision_id'] == revision
        assert calc['input_evidence']['input_revision'] == page['input_revision']
        assert calc['input_evidence']['history_version_id'] == page['history_version_id']
    drain(page['indicators'][0]['calculation']['run_id'])
    second_id = page['indicators'][1]['calculation']['run_id']
    with factory.begin() as db:
        run = db.get(FixedIndicatorRun, second_id)
        run.error, run.next_at = 'temporary_failure', 9999999999999
    partial = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    assert partial['bars'] == page['bars']
    assert partial['indicators'][0]['calculation']['visible_complete']
    assert partial['indicators'][1]['calculation']['error'] == 'temporary_failure'
    assert partial['indicators'][1]['calculation']['next_at'] == 9999999999999
    assert not partial['indicators'][1]['calculation']['visible_complete']
    with factory.begin() as db:
        db.get(FixedIndicatorRun, second_id).next_at = 0
    drain(second_id)
    ready = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    browser = client.post('/api/charts/data', json=query | {'provisional': False, 'track_history': True}).json()
    assert ready['bars'] == browser['bars']
    assert ready['indicators'] == browser['indicators']
    assert all(item['calculation']['visible_complete'] for item in ready['indicators'])
    for item in ready['indicators']:
        assert {v['time'] for s in item['series'] for v in s['values']} <= {bar['start'] for bar in ready['bars']}
        assert any(v['value'] is not None for s in item['series'] for v in s['values'])
    normalized = call(client, token, 'indicators_calculate', query | {'instrument': 'MWC:' + ident})
    assert normalized['structuredContent']['instrument'] == ident
    with factory.begin() as db:
        assert db.scalar(select(MarketDemand)) is None
        composites = list(db.scalars(select(MarketComposite)))
        assert len(composites) == 1 and composites[0].active_revision_id == revision


def test_composite_nulls_are_readable_after_computation(mcp, monkeypatch):
    from test_fixed_indicators import drain

    client, token, factory = mcp
    ident, _, _ = indicator_fixture(factory, monkeypatch)
    query = indicator_query(ident, indicators=[{'name': 'EMA', 'params': {'period': 200}}])
    first = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    drain(first['indicators'][0]['calculation']['run_id'])
    result = call(client, token, 'indicators_calculate', query)
    assert not result['isError'], result
    item = result['structuredContent']['page']['indicators'][0]
    assert item['calculation']['visible_complete'] and item['calculation']['status'] == 'complete'
    assert all(v['value'] is None for s in item['series'] for v in s['values'])
    assert all(not dep['initialized'] for dep in item['dependencies'])


def test_provisional_snapshot_and_unclosed_confirmed_bar(mcp, monkeypatch):
    import copy

    from alerts.storage import CompositeRevision, FixedIndicatorRun, ObservedMinute, RealtimeMapping
    from test_fixed_indicators import drain

    client, token, factory = mcp
    ident, revision, seam = indicator_fixture(factory, monkeypatch)
    stamp = seam + 650000
    monkeypatch.setattr('alerts.series_access.now_ms', lambda: stamp)
    with factory.begin() as db:
        mapping = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id)
        db.add(ObservedMinute(dataset_id=mapping.target_dataset_id, start=seam + 600000,
            epoch=1, sequence=1, observed_at=stamp,
            content={'start': seam + 600000, 'end': seam + 660000, 'open': '1.119',
                'high': '1.119', 'low': '1.119', 'close': '1.119', 'complete': False,
                'volume': None, 'volume_kind': 'unavailable', 'observation_complete': False,
                'connection_epoch': 1, 'source': 'oanda'}))
    query = indicator_query(ident, indicators=[{'name': 'EMA', 'params': {'period': 2}}])
    first = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    run_id = first['indicators'][0]['calculation']['run_id']
    drain(run_id)
    with factory.begin() as db:
        state = copy.deepcopy(db.get(FixedIndicatorRun, run_id).state)
    default = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    assert default['bars'][-1]['start'] == seam + 540000
    opted = call(client, token, 'indicators_calculate', query | {'provisional': True})
    assert not opted['isError'], opted
    page = opted['structuredContent']['page']
    assert page['display_snapshot_id']
    assert not page['bars'][-1]['time_closed'] and not page['bars'][-1]['source_confirmed']
    assert page['bars'][-1]['start'] == seam + 600000
    item = page['indicators'][0]
    assert item['calculation']['input_evidence']['display_snapshot_id'] == page['display_snapshot_id']
    assert item['calculation']['input_evidence']['input_revision'] == page['input_revision']
    assert item['series'][0]['values'][-1]['provisional']
    assert item['series'][0]['values'][-1]['value'] is not None
    with factory.begin() as db:
        assert db.get(FixedIndicatorRun, run_id).state == state
    # A confirmed source minute can still belong to a bucket that has not closed.
    monkeypatch.setattr('alerts.series_access.now_ms', lambda: seam + 550000)
    unclosed = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    bar = unclosed['bars'][-1]
    assert bar['source_confirmed'] and not bar['time_closed'] and not bar['complete']
    assert all(v['time'] < bar['start'] for s in unclosed['indicators'][0]['series'] for v in s['values'])


def test_sparse_signal_gap_and_different_parameters_remain_readable(mcp, monkeypatch):
    from test_fixed_indicators import drain

    client, token, factory = mcp
    ident, _, _ = indicator_fixture(factory, monkeypatch)
    query = indicator_query(ident, indicators=[{'name': 'EMA', 'params': {'period': 2}},
        {'name': 'EMA', 'params': {'period': 3}},
        {'name': 'SUPERTREND_PINE_V1', 'params': {'period': 2}}])
    first = call(client, token, 'indicators_calculate', query)['structuredContent']['page']
    runs = [item['calculation']['run_id'] for item in first['indicators']]
    assert len(set(runs)) == 3
    for run in runs:
        drain(run)
    response = call(client, token, 'indicators_calculate', query)
    assert not response['isError'], response
    page = response['structuredContent']['page']
    assert page['indicators'][0]['series'] != page['indicators'][1]['series']
    assert any(v.get('break_before') for s in page['indicators'][0]['series'] for v in s['values'])
    sparse = page['indicators'][2]
    assert sparse['calculation']['visible_complete']
    assert any(dep['initialized'] for dep in sparse['dependencies'])
    assert any(all(v['value'] is None for v in series['values']) for series in sparse['series'])


def test_composite_capacity_maps_to_resource_limit(mcp, monkeypatch):
    client, token, factory = mcp
    ident, _, _ = indicator_fixture(factory, monkeypatch)
    monkeypatch.setattr('alerts.indicator_demands.MAX_PENDING_RUNS', 0)
    result = call(client, token, 'indicators_calculate', indicator_query(ident))
    assert result['isError'] and result['structuredContent']['error']['code'] == 'RESOURCE_LIMIT', result
