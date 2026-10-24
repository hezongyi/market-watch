"""Independent literal Pine oracle plus application input/checkpoint contracts."""

import copy
import json
import math
import random

import pytest
from alerts.chart_indicators import calculate, history_requirement, public_catalog, validate
from alerts.indicator_state import IndicatorState
from alerts.observed_indicators import ObservedState
from alerts.rolling_range_squeeze import NAME

SPEC = {"name": NAME}


def bars(count=500):
    rng = random.Random(4686)
    return [dict(start=i * 60000, end=(i + 1) * 60000, complete=True,
                 open=100, close=100, high=100 + rng.choice([0.1, 0.2, 1, 2, 5]),
                 low=100 - rng.choice([0.1, 0.2, 1, 2, 5])) for i in range(count)]


def literal_pine(rows, k, lookback, pct, confirm=True, preview=False):
    """Translate source statements without using production state or percentile.

    Sort/rank is expressed by counting each candidate's position. All slices
    are relative to the input origin, independent of the streaming window.
    """
    queue, outputs, segments = [], [], []
    previous = False
    for i, row in enumerate(rows):
        confirmed = not (preview and i == len(rows) - 1)
        selected = rows[max(0, i - k + 1):i + 1]
        top, bottom = max(r['high'] for r in selected), min(r['low'] for r in selected)
        average = sum(r['close'] for r in selected) / k if i + 1 >= k else None
        ratio = (top - bottom) / average if average is not None and average != 0 else None
        threshold = rank = None
        if len(queue) >= lookback:
            rank_index = math.ceil(len(queue) * pct / 100)
            threshold = min(candidate for candidate in queue
                            if sum(value <= candidate for value in queue) >= rank_index)
            if ratio is not None:
                rank = 100.0 * sum(value <= ratio for value in queue) / len(queue)
        signal = threshold is not None and ratio is not None and ratio <= threshold and (not confirm or confirmed)
        if signal:
            if not previous:
                segments.append(dict(left=max(0, i-k+1), first=i, right=i, top=top, bottom=bottom, rank=rank))
            else:
                segments[-1]['right'] = i
        outputs.append((average, ratio, threshold, rank, int(signal)))
        previous = signal
        if confirmed and ratio is not None:
            queue.append(ratio)
            if len(queue) > lookback:
                queue.pop(0)
    return outputs, segments


def matrix(result):
    return list(zip(*[[p['value'] for p in s['values']] for s in result['series']]))


def test_label_rounds_half_up_like_pine_optional_two_decimals():
    rows = bars(33)
    for i, row in enumerate(rows):
        width = 0.25 if i == 0 else 0.5 if i == 32 else 1
        row.update(high=100 + width, low=100 - width)
    result = calculate(rows, dict(name=NAME, params=dict(k=1, lookback=32, low_pct=5)))
    assert result['presentation']['labels'][-1]['pct_rank'] == 3.125
    assert result['presentation']['labels'][-1]['text'] == 'PctRank: 3.13%'


@pytest.mark.parametrize('k,lookback,pct', [(1,20,0.1), (2,20,50), (10,252,5), (17,30,33.3)])
def test_literal_pine_numerical_and_box_parity(k, lookback, pct):
    rows = bars(650)
    params = dict(k=k, lookback=lookback, low_pct=pct)
    result = calculate(rows, SPEC | {'params': params})
    expected, segments = literal_pine(rows, k, lookback, pct)
    for actual, oracle in zip(matrix(result), expected):
        assert actual == pytest.approx(oracle, abs=1e-12)
    boxes, labels = result['presentation']['boxes'], result['presentation']['labels']
    assert len(labels) == len(segments) > 0
    assert len(boxes) == sum(1 + (s['right'] > s['first']) for s in segments)
    for segment, label in zip(segments, labels):
        assert label['time'] == rows[segment['first']]['start']
        assert label['price'] == segment['top'] and label['pct_rank'] == segment['rank']
        group = [b for b in boxes if b['first'] == label['time']]
        assert group[-1]['kind'] == 'first', 'green box is above orange'
        for box in group:
            assert box['left'] == rows[segment['left']]['start']
            assert box['top'] == segment['top'] and box['bottom'] == segment['bottom']
            assert box['right'] == rows[segment['first'] if box['kind']=='first' else segment['right']]['start']


def test_warmup_prior_queue_ties_zero_denominator_and_negative_sma():
    rows = [dict(r, high=101, low=99) for r in bars(35)]
    result = calculate(rows, SPEC | {'params': {'k':3,'lookback':20}})
    values = matrix(result)
    assert values[1][0] is None and values[2][0] == 100
    assert all(v[2] is None for v in values[:22])
    assert values[22] == (100, 0.02, 0.02, 100, 1)
    assert result['presentation']['labels'][0]['text'] == 'PctRank: 100%'
    rows[22].update(high=100.1, low=99.9)
    # k=1: collapsing current range must not reduce its own threshold.
    result = calculate(rows, SPEC | {'params': {'k':1,'lookback':20}})
    assert matrix(result)[22][2] == 0.02 and matrix(result)[22][-1] == 1
    for r in rows:
        r.update(close=0, open=0, high=1, low=-1)
    assert all(v[1] is None and v[2] is None and v[4]==0 for v in matrix(calculate(rows,SPEC)))
    for r in rows:
        r.update(close=-10, open=-10, high=-9, low=-11)
    assert matrix(calculate(rows,SPEC|{'params':{'k':1,'lookback':20}}))[-1][1] == -0.2


@pytest.mark.parametrize('confirm', [True,False])
def test_provisional_rollback_confirm_once_and_isolated_observed_state(confirm):
    rows = [dict(r, high=101, low=99) for r in bars(45)]
    spec = SPEC | {'params':{'k':3,'lookback':20,'confirm_on_close':confirm}}
    engines = [IndicatorState(spec),ObservedState(spec)]
    for engine in engines:
        for row in rows[:-1]:
            engine.step(row)
        checkpoint = json.loads(json.dumps(engine.checkpoint(), allow_nan=False))
        forming = dict(rows[-1],complete=False,time_closed=False)
        a = engine.step(forming,provisional=True)
        assert a['signal'] == int(not confirm)
        first_display = copy.deepcopy(engine.last_presentation)
        engine.step(dict(forming,high=200),provisional=True)
        assert engine.step(forming,provisional=True) == a
        assert engine.last_presentation == first_display
        assert engine.checkpoint() == checkpoint
        engine.step(rows[-1])
        underlying = engine.engine if isinstance(engine,ObservedState) else engine
        assert underlying.state['n'] == len(rows)
        assert len(underlying.state['ratios']) == 20
        expected = calculate(rows,spec)
        assert underlying.last_presentation == expected['presentation']
    preview = calculate([*rows[:-1],dict(rows[-1],complete=False)],spec,provisional=True)
    assert matrix(preview)[-1][-1] == int(not confirm)
    assert preview['series'][0]['values'][-1]['provisional']


def test_serialized_checkpoints_future_causality_and_timestamp_geometry():
    rows = bars(450)
    for i,row in enumerate(rows):
        row['start'] += (i//37)*60000*60*48
        row['end'] = row['start']+60000
        row['chart_time'] = row['start']+12345
    spec = SPEC | {'params': {'k':5,'lookback':20}}
    expected = calculate(rows,spec)
    engine = IndicatorState(spec)
    for i,row in enumerate(rows):
        if i % 19 == 0:
            engine = IndicatorState(spec,json.loads(json.dumps(engine.checkpoint(),allow_nan=False)))
        assert tuple(engine.step(row).values()) == matrix(expected)[i]
        if i in (40,175,449):
            assert engine.last_presentation == calculate(rows[:i+1],spec)['presentation']
    assert engine.last_presentation == expected['presentation']
    assert all(b['left_chart_time']==b['left']+12345 and b['right_chart_time']==b['right']+12345
               for b in expected['presentation']['boxes'])
    with pytest.raises(ValueError):
        IndicatorState(SPEC|{'params':{'k':6}},engine.checkpoint())


def test_pine_separate_box_label_retention_limits_and_new_segments():
    # Alternating tiny/wide bars produce >500 disjoint segments for K=1.
    rows = bars(1300)
    for i,row in enumerate(rows):
        width = 0.1 if i % 2 else 5
        row.update(high=100+width,low=100-width)
    result = calculate(rows,SPEC|{'params':{'k':1,'lookback':20,'low_pct':50}})
    assert len(result['presentation']['boxes']) == 500
    assert len(result['presentation']['labels']) == 500
    assert all(b['left']==b['right'] for b in result['presentation']['boxes'])
    json.dumps(result,allow_nan=False)


def test_catalog_and_boolean_color_contract():
    from alerts.chart_indicators import validate_display

    meta = public_catalog()[NAME]
    assert meta['params'] == {'k':10,'lookback':252,'low_pct':5.0,'confirm_on_close':True}
    assert history_requirement(SPEC) == 261
    assert len(meta['display_inputs']) == 7
    for bad in (0,1,'true',None):
        with pytest.raises(ValueError):
            validate(SPEC|{'params':{'confirm_on_close':bad}})
    for params in ({'k':0},{'lookback':19},{'low_pct':0},{'low_pct':50.1}):
        with pytest.raises(ValueError):
            validate(SPEC|{'params':params})
    with pytest.raises(ValueError):
        validate_display(NAME,{'sma_color':'<script>'})
    assert calculate([],SPEC)['presentation']['boxes'] == []


@pytest.mark.parametrize('policy',['strict_confirmed_v1','observed_display_v1'])
def test_fixed_history_worker_pagination_and_durable_presentation(database,monkeypatch,policy):
    from alerts.chart_api import DataQuery, data_sync
    from test_fixed_indicators import drain, history

    version=history(database,monkeypatch,count=1100)
    spec=SPEC|{'params':{'k':3,'lookback':20,'low_pct':50}}
    query=DataQuery(instrument=version,series_kind='history',timeframe='M1',limit=30,
                    indicators=[spec],indicator_input_policy=policy)
    pending=data_sync(query)
    drain(pending['indicator_progress'][0]['run_id'])
    latest=data_sync(query)
    older=data_sync(query.model_copy(update={'before':600*60000}))
    assert latest['indicators'][0]['presentation'] == older['indicators'][0]['presentation']
    assert latest['indicators'][0]['presentation']['history_complete'] is True
    assert latest['indicators'][0]['presentation']['boxes']
    assert len(older['bars']) == 30 and all(b['start']<600*60000 for b in older['bars'])


def test_provider_snapshot_old_viewport_keeps_full_boxes(database,monkeypatch):
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts.chart_api import DataQuery
    from test_provider_cache import META, seed

    rows=bars(310)
    for row in rows:
        row['chart_time']=row['start']+1234
    seed(META,'M5',rows[-1]['end'],{'bars':rows,'history_boundary':True})
    monkeypatch.setattr(upstream,'metadata',lambda *_a,**_kw:META)
    monkeypatch.setattr(upstream,'native_page',lambda *_a,**_kw:pytest.fail('cache only'))
    spec=SPEC|{'params':{'k':2,'lookback':20,'low_pct':50}}
    query=DataQuery(instrument=META['id'],series_kind='provider',timeframe='M5',
                    before=rows[-1]['end'],limit=15,indicators=[spec])
    latest=cache.data(query)
    older=cache.data(query.model_copy(update={'before':rows[150]['start']}))
    assert latest['indicators'][0]['presentation'] == older['indicators'][0]['presentation']
    assert latest['indicators'][0]['presentation']['boxes']


def test_observed_missing_minutes_continue_sequence_and_keep_quality():
    rows=bars(90)
    spec=SPEC|{'params':{'k':3,'lookback':20}}
    engine=ObservedState(spec)
    values=[]
    for i,row in enumerate(rows):
        values.append(engine.step(dict(row,complete=i%3!=0,gap_before=i==35)))
    assert [tuple(value.values()) for value in values] == matrix(calculate(rows,spec))
    assert engine.last_quality['coverage']=='unverified'
    assert engine.last_presentation['input_quality']['coverage']=='unverified'


def test_published_viewport_keeps_full_presentation(database):
    from alerts import managed_dataset
    from alerts.chart_api import DataQuery
    from alerts.storage import ChartPublication, ChartPublishedBar

    rows = bars(90)
    with database.begin() as db:
        db.add(ChartPublication(instrument_id='BTCUSDT', timeframe='M1', start=0,
                                end=rows[-1]['end'], complete_count=len(rows), initialized=True))
        for row in rows:
            db.add(ChartPublishedBar(instrument_id='BTCUSDT', timeframe='M1',
                                    start=row['start'], end=row['end'], complete=True, payload=row))
    spec = SPEC | {'params': {'k': 3, 'lookback': 20, 'low_pct': 50}}
    query = DataQuery(instrument='BTCUSDT', published=True, timeframe='M1',
                      before=rows[-1]['end'], limit=3, indicators=[spec])
    latest = managed_dataset.data(query)
    older = managed_dataset.data(query.model_copy(update={'before': rows[40]['start']}))
    assert latest['indicators'][0]['presentation'] == older['indicators'][0]['presentation']
    assert latest['indicators'][0]['presentation']['boxes']
    assert len(older['bars']) == 3


def test_composite_preview_is_page_independent_and_not_persisted(database, monkeypatch):
    from alerts import composite_chart
    from alerts import fixed_indicators as jobs
    from alerts.storage import FixedIndicatorRun
    from test_composite_chart import populated
    from test_fixed_indicators import aggregates, drain

    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, 'M1')
    spec = SPEC | {'params': {'k': 1, 'lookback': 20, 'confirm_on_close': False}}
    stamp = seam + 650000
    with database.begin() as db:
        page = composite_chart.chart_page(db, composite, 'M1', now=stamp, count=20)
        ident = jobs.request(db, page, spec, stamp=stamp).id
    drain(ident)
    forming = dict(page['bars'][-1], start=seam+600000, end=seam+660000,
                   complete=False, high='1.12', low='1.11')
    page['bars'].append(forming)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, ident)
        original = copy.deepcopy(run.state)
        latest, _ = jobs.chart_results(db, page, [spec], provisional=True, stamp=stamp)
        monkeypatch.setattr(composite_chart, 'chart_page', lambda *_a, **_kw: page)
        older_page = dict(page, bars=page['bars'][:2])
        older, _ = jobs.chart_results(db, older_page, [spec], provisional=True, stamp=stamp)
        assert latest[0]['presentation'] == older[0]['presentation']
        assert latest[0]['presentation']['as_of_bar_time'] == forming['start']
        assert run.state == original


def test_alert_signal_operand_matches_chart_and_confirm_filter():
    from alerts.chart_alert_domain import Operand
    from alerts.chart_alert_values import operand_values

    rows = bars(50)
    for row in rows:
        row.update(high=101, low=99)
    rows[-1]['complete'] = False
    for confirm in (True, False):
        spec = SPEC | {'params': {'k': 2, 'lookback': 20, 'confirm_on_close': confirm}}
        operand = Operand(kind='indicator', indicator=dict(spec, output='signal'))
        values = operand_values(rows, operand, provisional=True)
        assert list(map(float, values)) == [v['value'] for v in
                                           calculate(rows, spec, provisional=True)['series'][-1]['values']]
        assert values[-1] == int(not confirm)


def test_authenticated_alert_capabilities_and_boolean_rule_save(database, monkeypatch):
    from alerts import api as api_module
    from fastapi.testclient import TestClient
    from test_chart_alert_api import login
    from test_chart_alert_service import config
    from test_composite_chart import populated

    composite, _, _ = populated(database, monkeypatch)
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        for instrument, kind in [('EURUSD', 'managed'), (composite, 'composite')]:
            response = client.post('/api/chart-alerts/capabilities', json={
                'instrument': instrument, 'series_kind': kind, 'timeframe': 'M5'})
            assert response.status_code == 200, response.text
            result = response.json()
            assert NAME in result['indicators']
            assert result['indicator_metadata'][NAME]['parameter_schema']['confirm_on_close']['type'] == 'bool'
        spec = dict(name=NAME, version='1', output='signal',
                    params=dict(k=1, lookback=20, low_pct=0.1, confirm_on_close=False))
        payload = config(name='Rolling Range Squeeze', max_triggers=1,
                         message='Rolling Range Squeeze triggered',
                         condition=dict(relation='above', left=dict(kind='indicator', indicator=spec),
                                        right=dict(kind='constant', value='0')))
        saved = client.post('/api/chart-alerts', json={
            'request_id': 'squeeze-bool-save', 'config': payload.model_dump(mode='json')})
        assert saved.status_code == 201, saved.text
        assert saved.json()['config']['condition']['left']['indicator'] == spec
