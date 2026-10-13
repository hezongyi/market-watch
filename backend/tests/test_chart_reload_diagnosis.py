"""Diagnosis probes: stream-observed tail across REST-confirmation lag."""
import pytest
from alerts import live_pricing as live
from alerts import series_access
from alerts.chart_api import DataQuery
from alerts.market_contracts import DatasetIdentity, QuoteEvent
from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
from test_composite_chart import populated

@pytest.mark.parametrize('transition', ['minute_rollover', 'quote_age_16s', 'reconnect'])
@pytest.mark.parametrize('cached', [False, True])
def test_observed_m1_does_not_vanish_before_rest_confirmation(database, monkeypatch, transition, cached):
    composite, revision_id, _ = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = 200011000
    clock = [at]
    monkeypatch.setattr(series_access, 'now_ms', lambda: clock[0])
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    from alerts.composite_realtime import CurrentBuckets
    cache = CurrentBuckets() if cached else None
    def publish(stamp, sequence):
        live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid='1.10', ask='1.11',
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
            sequence=sequence), {'EUR_USD': ident}, now=stamp)
    def starts():
        with database.begin() as db:
            page = series_access.chart_data(db, DataQuery(instrument=composite,
                series_kind='composite', timeframe='M1'), realtime=cache)
            return [bar['start'] for bar in page['bars']]
    publish(at, 1)
    prior = at // 60000 * 60000
    assert starts()[-1] == prior
    if transition == 'minute_rollover':
        live.renew(owner, now=at + 15000)
        clock[0] = prior + 60000 + 1000
        publish(clock[0], 2)
    elif transition == 'quote_age_16s':
        clock[0] += 16000
    else:
        live.begin_connection(owner, {'EUR_USD': ident}, now=at + 1000)
    after = starts()
    assert prior in after, f'{transition}: stream-observed M1 {prior} vanished; tail is {after[-3:]}'
    # A fresh worker/page reconstructs the same accepted observations.
    cache = CurrentBuckets() if cached else None
    assert starts() == after


def test_exact_price_snapshot_survives_later_tick_and_confirmation(database, monkeypatch):
    from alerts.chart_api import DataQuery
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.composite_chart import chart_page
    from test_market_contracts import batch, minute

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = seam + 600010
    clock = [at]
    monkeypatch.setattr(series_access, 'now_ms', lambda: clock[0])
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    def publish(price, stamp, sequence):
        live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid=price, ask='1.21',
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
            sequence=sequence), {'EUR_USD': ident}, now=stamp)
    publish('1.10', at, 1)
    query = DataQuery(instrument=composite, series_kind='composite', timeframe='M1')
    with database.begin() as db:
        original = series_access.chart_data(db, query)
    snapshot = original['display_snapshot_id']
    clock[0] += 1000
    publish('1.20', clock[0], 2)
    with database.begin() as db:
        current = series_access.chart_data(db, query)
        replay = series_access.chart_data(db, query.model_copy(update={'display_snapshot_id': snapshot}))
        assert current['bars'][-1]['close'] == '1.20'
        assert replay['bars'] == original['bars']
        assert replay['display_snapshot_id'] == snapshot != current['display_snapshot_id']
        apply_minutes(db, record(db, batch(identity=ident, window_start=seam + 600000,
            window_end=seam + 660000, checkpoint=seam + 660000, observed_at=seam + 660010,
            volume_kind='price_count', volume_unit='quotes', rows=(minute(seam + 600000, high='1.20', close='1.19', volume='3'),))))
    with database.begin() as db:
        replay = series_access.chart_data(db, query.model_copy(update={'display_snapshot_id': snapshot}))
        assert replay['bars'] == original['bars'], 'confirmation GC must not mutate accepted snapshot content'
        fixed = chart_page(db, composite, 'M1', input_revision=1, now=clock[0])
        assert all(bar['start'] < seam + 600000 for bar in fixed['bars'])


@pytest.mark.parametrize('revised', [False, True])
@pytest.mark.parametrize('extremes', ['expand', 'shrink'])
def test_older_observed_confirmation_resets_only_for_price_change(database, monkeypatch, revised, extremes):
    from types import SimpleNamespace
    from alerts import market_stream as stream
    from alerts.chart_api import DataQuery
    from alerts.composite_chart import chart_page
    from test_fixed_indicators import add_tail
    from test_market_contracts import minute

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = seam + 600010
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    for index in range(2):
        stamp = at + index * 60000
        if index:
            live.renew(owner, now=at + 15000)
            live.renew(owner, now=at + 30000)
            live.renew(owner, now=at + 45000)
        live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid='1.10', ask='1.11',
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
            sequence=index * 20 + 1), {'EUR_USD': ident}, now=stamp)
        if not index and extremes == 'shrink':
            live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid='1.11', ask='1.12',
                source_time=stamp + 1000, received_at=stamp + 1000, tradeable=True,
                connection_epoch=epoch, sequence=10), {'EUR_USD':ident}, now=stamp + 1000)
    stamp = at + 60000
    monkeypatch.setattr(stream, 'now_ms', lambda: stamp)
    with database.begin() as db:
        original = chart_page(db, composite, 'M1', provisional=True, now=stamp)
    first, latest = original['bars'][-2:]
    add_tail(database, revision_id, [minute(first['start'], open='1.10', low='1.10',
        high=('1.11' if not revised else '1.105') if extremes == 'shrink' else '1.11' if revised else '1.10',
        close=('1.11' if not revised else '1.105') if extremes == 'shrink' else '1.10', volume=None)])
    query = DataQuery(instrument=composite, series_kind='composite', timeframe='M1')
    state = {'history_accepted': True, 'historical': False, 'loaded_before': latest['start'],
        'loaded_after': seam, 'cursor': latest['start'], 'binding': revision_id,
        'initial_input_revision': 1, 'display_snapshot_id': original['display_snapshot_id']}
    with database.begin() as db:
        page = chart_page(db, composite, 'M1', provisional=True, now=stamp)
        payload = {**page, 'calendar': 'ny17', 'type': 'bars', 'resolved_revision_id': revision_id}
        event = stream.delivery(db, SimpleNamespace(query=query.model_dump(), identity={}),
            SimpleNamespace(listener='test', generation=1, state=state), payload, {})
        assert (event['type'] == 'reset') == revised
        if revised:
            assert event['reason'] == 'history_changed'
        else:
            assert event['type'] == 'bars'


@pytest.mark.parametrize('exhausted', [False, True, 'tasks', 'bytes', 'failures'])
def test_display_replay_budget_uses_shared_background_job(database, monkeypatch, exhausted):
    from alerts import display_indicators, display_indicator_jobs as display_jobs, fixed_indicators as fixed
    from alerts.composite_chart import chart_page
    from test_composite_aggregates import drain as aggregate
    from test_fixed_indicators import drain

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    stamp = seam + 600010
    owner = live.claim(live.settings.oanda_account_id, now=stamp)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=stamp)
    live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid='1.10', ask='1.11',
        source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch, sequence=1),
        {'EUR_USD': ident}, now=stamp)
    aggregate(revision_id, 'M1')
    spec = {'name': 'SUPERTREND_PINE_V1', 'params': {'period': 2}}
    with database.begin() as db:
        page = chart_page(db, composite, 'M1', provisional=True, now=stamp)
        run = fixed.request(db, page, spec, stamp=stamp)
        run_id = run.id
    drain(run_id)
    monkeypatch.setattr(display_indicators, 'MAX_REPLAY_ROWS', 0)
    monkeypatch.setattr(display_jobs, 'now_ms', lambda: stamp)
    if exhausted is True:
        monkeypatch.setattr(display_jobs, 'MAX_OUTPUT_ROWS', 0, raising=False)
    elif exhausted == 'tasks':
        monkeypatch.setattr(display_jobs, 'MAX_TASKS', 0)
        with database.begin() as db:
            with pytest.raises(ValueError) as caught:
                fixed.chart_results(db, page, [spec], provisional=True, stamp=stamp)
            assert caught.value.code == 'DISPLAY_TASK_CAPACITY'
        assert display_jobs.tick() is False
        return
    with database.begin() as db:
        _, progress = fixed.chart_results(db, page, [spec], provisional=True, stamp=stamp)
        assert progress[0]['display_status'] == 'pending'
    if exhausted == 'bytes':
        monkeypatch.setattr(display_jobs, 'MAX_OUTPUT_BYTES', 0)
    if exhausted == 'failures':
        from alerts import composite_series
        from alerts.storage import DisplayIndicatorTask
        def failed_read(*args, **kwargs):
            raise RuntimeError('temporary replay failure')
        monkeypatch.setattr(composite_series, 'read_window', failed_read)
        for failure in range(display_jobs.MAX_FAILURES):
            assert display_jobs.tick()
            with database.begin() as db:
                task = db.query(DisplayIndicatorTask).one()
                assert task.status == ('error' if failure == display_jobs.MAX_FAILURES - 1 else 'pending')
                task.next_at = stamp
        with database.begin() as db:
            with pytest.raises(ValueError) as caught:
                fixed.chart_results(db, page, [spec], provisional=True, stamp=stamp)
            assert caught.value.code == 'DISPLAY_REPLAY_FAILED'
        assert display_jobs.tick() is False
        return
    assert display_jobs.tick()
    if exhausted:
        from alerts.storage import DisplayIndicatorTask

        with database.begin() as db:
            task = db.query(DisplayIndicatorTask).one()
            assert task.status == 'error', 'a hard output limit must terminate rather than retry forever'
            with pytest.raises(ValueError) as caught:
                fixed.chart_results(db, page, [spec], provisional=True, stamp=stamp)
            assert caught.value.code == ('DISPLAY_TASK_CAPACITY' if exhausted == 'bytes' else 'DISPLAY_SUFFIX_CAPACITY_EXCEEDED')
        assert display_jobs.tick() is False
        return
    with database.begin() as db:
        actual, progress = fixed.chart_results(db, page, [spec], provisional=True, stamp=stamp)
        assert progress[0]['display_status'] == 'complete'
        assert actual[0]['dependencies'][-1]['provisional']
        assert actual[0]['dependencies'][-1]['start'] == seam + 600000


@pytest.mark.parametrize('later_confirmed', [False, True])
def test_real_observed_supertrend_suffix_matches_complete_price_sequence(database, monkeypatch, later_confirmed):
    from alerts import fixed_indicators as fixed
    from alerts.chart_indicators import calculate
    from alerts.composite_chart import chart_page
    from alerts.indicator_state import IndicatorState
    from test_composite_aggregates import drain as aggregate
    from test_fixed_indicators import drain, add_tail
    from test_market_contracts import minute

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = seam + 600010
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    for index in range(3):
        stamp = at + index * 60000
        if index:
            for delta in [15000, 30000, 45000]:
                live.renew(owner, now=stamp - 60000 + delta)
        price = str(1.11 - .001 * index)
        live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid=price, ask='1.12',
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
            sequence=index + 1), {'EUR_USD': ident}, now=stamp)
    if later_confirmed:
        add_tail(database, revision_id, [minute(seam + 720000, open='1.108', high='1.108', low='1.108', close='1.108', volume='3')])
    aggregate(revision_id, 'M1')
    spec = {'name': 'SUPERTREND_PINE_V1', 'params': {'period': 2, 'multiplier': .1}}
    with database.begin() as db:
        page = chart_page(db, composite, 'M1', count=20, now=stamp + 60000, provisional=True)
        run_id = fixed.request(db, page, spec, stamp=stamp + 60000).id
    drain(run_id)
    # Independent vector algorithm over the exact accepted sequence; gaps are
    # retained, observations are admitted only in this numerical reference.
    vector = [{**bar, 'complete': True} for bar in page['bars']]
    reference = calculate(vector, spec)
    with database.begin() as db:
        result, _ = fixed.chart_results(db, page, [spec], provisional=True, stamp=stamp + 60000)
    for series in reference['series']:
        expected = [point['value'] for point in series['values'] if point['time'] >= seam + 600000]
        actual = next(item for item in result[0]['series'] if item['key'] == series['key'])
        assert [point['value'] for point in actual['values'] if point['time'] >= seam + 600000] == pytest.approx(expected, abs=1e-10)
    assert all(row['provisional'] for row in result[0]['dependencies'] if row['start'] >= seam + 600000)


def test_display_capacity_freezes_append_and_old_backfill_demand_survives_empty(database, monkeypatch):
    from alerts import display_observations as observations
    from alerts.market_contracts import RequestResult
    from test_market_contracts import batch
    from alerts.storage import LiveState

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = seam + 600010
    clock = [at]
    monkeypatch.setattr(series_access, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(observations, 'MAX_MINUTES', 1)
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    def publish(stamp, seq):
        live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid='1.10', ask='1.11',
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch, sequence=seq),
            {'EUR_USD': ident}, now=stamp)
    publish(at, 1)
    for delta in (15000, 30000, 45000):
        live.renew(owner, now=at + delta)
    clock[0] += 60000
    publish(clock[0], 2)
    with database.begin() as db:
        page = series_access.chart_data(db, DataQuery(instrument=composite, series_kind='composite', timeframe='M1'))
        assert page['bars'][-1]['start'] == seam + 600000
        assert any('暂停追加' in reason for reason in page['pending'])
        state = db.get(LiveState, ident.key)
        state.ready, state.confirmed_end = True, seam + 1020000
    # Even with the fixed highest watermark far ahead, a much older accepted
    # minute remains a confirmation demand. Successful empty does not delete it.
    for offset in range(15000, 300001, 15000):
        live.renew(owner, now=clock[0] + offset)
    clock[0] += 300000
    window = live.confirmation_window(owner, epoch, ident, now=clock[0])
    assert window[0] == seam + 600000
    live.commit_confirmation(owner, epoch, batch(identity=ident, window_start=window[0],
        window_end=window[1], rows=(), result=RequestResult(status='empty_success'),
        volume_kind='price_count', volume_unit='quotes', observed_at=clock[0]), now=clock[0])
    with database.begin() as db:
        page = series_access.chart_data(db, DataQuery(instrument=composite, series_kind='composite', timeframe='M1'))
        assert page['bars'][-1]['start'] == seam + 600000


def test_snapshot_expiry_and_capacity_return_recoverable_codes(database, monkeypatch):
    from alerts import display_snapshots as snapshots
    from alerts.storage import DisplaySnapshot

    composite, _, _ = populated(database, monkeypatch)
    clock = [200011000]
    monkeypatch.setattr(series_access, 'now_ms', lambda: clock[0])
    query = DataQuery(instrument=composite, series_kind='composite', timeframe='M1')
    with database.begin() as db:
        initial = series_access.chart_data(db, query)
        token = initial['display_snapshot_id']
        db.get(DisplaySnapshot, token).expires_at = clock[0] - 1
    with database.begin() as db:
        with pytest.raises(ValueError) as caught:
            series_access.chart_data(db, query.model_copy(update={'display_snapshot_id': token}))
        assert caught.value.code == 'DISPLAY_SNAPSHOT_EXPIRED'
        fresh = series_access.chart_data(db, query)
        assert fresh['display_snapshot_id'] == token, 'unchanged exact content can renew after expiry'
    clock[0] += 60000
    monkeypatch.setattr(snapshots, 'MAX_SNAPSHOTS', 1)
    with database.begin() as db:
        with pytest.raises(ValueError) as caught:
            series_access.chart_data(db, query)
        assert caught.value.code == 'DISPLAY_SNAPSHOT_CAPACITY'
        assert db.get(DisplaySnapshot, token), 'capacity must never evict a leased price credential'
    clock[0] += snapshots.LEASE_MS + 1
    with database.begin() as db:
        assert series_access.chart_data(db, query)['display_snapshot_id'] != token


@pytest.mark.parametrize('valid', [False, True])
@pytest.mark.parametrize('entry', ['read', 'reconnect'])
def test_legacy_quote_handover_never_copies_uncertified_forming(database, monkeypatch, valid, entry):
    from alerts.storage import LiveState, ObservedMinute

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = seam + 600010
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    with database.begin() as db:
        state = db.get(LiveState, ident.key)
        state.quote = QuoteEvent(identity=ident, bid='1.10', ask='1.11',
            source_time=at, received_at=at, tradeable=valid, connection_epoch=epoch, sequence=1).model_dump(mode='json')
        state.forming = {'start': at // 60000 * 60000, 'end': at // 60000 * 60000 + 60000,
            'open': '99', 'high': '999', 'low': '.01', 'close': '1.10'}
        assert db.get(ObservedMinute, (ident.key, at // 60000 * 60000, epoch)) is None
    monkeypatch.setattr(series_access, 'now_ms', lambda: at + 16000)
    if entry == 'reconnect':
        live.begin_connection(owner, {'EUR_USD': ident}, now=at + 1000)
    with database.begin() as db:
        page = series_access.chart_data(db, DataQuery(instrument=composite, series_kind='composite', timeframe='M1'))
        observed = db.get(ObservedMinute, (ident.key, at // 60000 * 60000, epoch))
        assert bool(observed) is valid
        if valid:
            assert page['bars'][-1]['start'] == at // 60000 * 60000
            assert all(observed.content[key] == '1.10' for key in ('open', 'high', 'low', 'close'))
        assert db.get(LiveState, ident.key).ready is False, 'display handover cannot restore live alert readiness'
