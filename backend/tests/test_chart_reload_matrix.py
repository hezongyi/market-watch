"""Persisted accepted inputs across gaps, pagination and actual confirmation."""
import copy

import pytest
from alerts import fixed_indicators as fixed
from alerts import live_pricing as live
from alerts import series_access
from alerts.chart_indicators import calculate
from alerts.chart_query import DataQuery
from alerts.market_contracts import DatasetIdentity, QuoteEvent
from alerts.storage import CompositeRevision, FixedIndicatorRun, MarketDataset, RealtimeMapping
from test_composite_aggregates import drain as aggregate
from test_composite_chart import populated
from test_fixed_indicators import add_tail, drain
from test_market_contracts import minute


@pytest.mark.parametrize('frame', ['M1', 'M5'])
@pytest.mark.parametrize('gap', [False, True])
def test_pending_gap_pages_confirmation_and_recursive_values(database, monkeypatch, frame, gap):
    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        dataset = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(dataset.identity)
    at = seam + 600010
    clock = [at]
    monkeypatch.setattr(series_access, 'now_ms', lambda: clock[0])
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': identity}, now=at)
    # Two whole higher-period tails, with a real hole inside the first M5.
    for index in range(10):
        stamp = at + index * 60000
        if index:
            for offset in (15000, 30000, 45000):
                live.renew(owner, now=stamp - 60000 + offset)
        clock[0] = stamp
        if gap and index == 2:
            live.publish_event(owner, epoch, {'type':'heartbeat', 'received_at':stamp,
                'connection_epoch':epoch}, {'EUR_USD':identity}, now=stamp)
            continue
        price = str(1.1 + index * .001)
        live.publish_event(owner, epoch, QuoteEvent(identity=identity, bid=price, ask='1.2',
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
            sequence=index + 1), {'EUR_USD':identity}, now=stamp)
    aggregate(revision_id, frame)
    query = DataQuery(instrument=composite, series_kind='composite', timeframe=frame, limit=2000)
    spec = {'name':'SUPERTREND_PINE_V1', 'params':{'period':2, 'multiplier':.5}}
    with database.begin() as db:
        page = series_access.chart_data(db, query)
        run_id = fixed.request(db, page, spec, stamp=clock[0]).id
    drain(run_id)
    with database.begin() as db:
        run = db.get(FixedIndicatorRun, run_id)
        original = copy.deepcopy(run.state)
        _, _, phase, profiles = fixed._context(db, run)
        profiles = [*profiles[:-1], (profiles[-1][0], page['bars'][-1]['end'], profiles[-1][2])] if profiles else []
        vector, previous = [], None
        for bar in page['bars']:
            vector.append({**bar, 'complete':bar.get('display_coverage_complete', bar['complete']),
                'gap_before':fixed.gap_before(previous, bar['start'], phase, profiles)})
            previous = bar['end']
        reference = calculate(vector, spec)
        result, _ = fixed.chart_results(db, page, [spec], provisional=True, stamp=clock[0])
        assert run.state == original
        for series in reference['series']:
            expected = [p['value'] for p in series['values']]
            actual = next(s for s in result[0]['series'] if s['key']==series['key'])
            assert [p['value'] for p in actual['values']] == pytest.approx(expected, abs=1e-10)
    # Read different small pages from one credential after a real shrinking
    # confirmation. Readers must preserve the earlier accepted price content.
    first = seam + 600000
    add_tail(database, revision_id, [minute(first, open='1.1', high='1.1', low='1.1', close='1.1', volume=None)])
    aggregate(revision_id, frame)
    before, found = None, []
    for _ in range(20):
        with database.begin() as db:
            pinned = series_access.chart_data(db, query.model_copy(update={
                'limit':2, 'before':before, 'display_snapshot_id':page['display_snapshot_id']}))
        found = pinned['bars'] + found
        if not pinned['has_more']:
            break
        before = pinned['next_before']
    assert found == page['bars']
    if gap and frame == 'M5':
        assert any(not b['display_coverage_complete'] for b in page['bars'] if b['start']>=first)
    if gap and frame == 'M1':
        assert first + 120000 not in [b['start'] for b in page['bars']], 'no synthetic gap filling'
    # An authoritative late revision changes the full dependency suffix. The
    # current result must match a whole-sequence calculation, while the old
    # fixed run and already accepted display credential stay unchanged.
    confirmed = [minute(first + i * 60000, open='1.1', high='1.11', low='1.095',
        close=str(1.1 + i * .0002), volume=None) for i in range(10) if not (gap and i==2)]
    add_tail(database, revision_id, confirmed)
    aggregate(revision_id, frame)
    current_spec = query.model_copy(update={'indicators':[spec]})
    with database.begin() as db:
        current_page = series_access.chart_data(db, current_spec)
        next_run = current_page['indicator_progress'][0]['run_id']
    drain(next_run)
    with database.begin() as db:
        current = series_access.chart_data(db, current_spec)
        _, _, phase, profiles = fixed._context(db, db.get(FixedIndicatorRun, next_run))
        previous, vector = None, []
        for bar in current['bars']:
            vector.append({**bar, 'complete':bar.get('display_coverage_complete', bar['complete']),
                'gap_before':fixed.gap_before(previous, bar['start'], phase, profiles)})
            previous = bar['end']
        expected = calculate(vector, spec)
        for series in expected['series']:
            actual = next(s for s in current['indicators'][0]['series'] if s['key']==series['key'])
            assert [p['value'] for p in actual['values']] == pytest.approx([p['value'] for p in series['values']], abs=1e-10)
        assert db.get(FixedIndicatorRun, run_id).state == original
