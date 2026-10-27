"""Managed live choice preserves historical inputs and fences executable rules."""

import copy

import pytest
from alerts import api, market
from alerts.chart_alert_service import create, lifecycle
from alerts.chart_alert_worker import evaluate
from alerts.chart_history_plan import advance_plan
from alerts.chart_query import DataQuery
from alerts.composite_quotes import live_snapshot
from alerts.managed_dataset import join
from alerts.market_data import renew_demand
from alerts.market_usage import composite_targets, wanted_instruments
from alerts.realtime_switch import enabled, set_enabled, status
from alerts.series_access import chart_data
from alerts.storage import (
    Audit,
    ChartAlert,
    ChartAlertAction,
    ChartHistoryPlan,
    CompositePreparation,
    CompositeRevision,
    DisplaySnapshot,
    HistoryVersion,
    ImportJob,
    Instrument,
    LiveState,
    MarketComposite,
    MarketDataset,
    MarketDemand,
    Preference,
    RealtimeMapping,
    SignalRow,
)
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_composite_alerts import armed, config, live
from test_composite_chart import populated
from test_managed_dataset import START


def source_id(db, revision_id):
    revision = db.get(CompositeRevision, revision_id)
    return db.get(MarketDataset, db.get(HistoryVersion, revision.history_version_id).dataset_id).instrument_id


@pytest.mark.parametrize('consumer', ['none', 'expired', 'chart', 'alert'])
def test_compatibility_default_requires_existing_live_consumers(database, monkeypatch, consumer):
    composite, revision, _ = populated(database, monkeypatch)
    stamp = START
    monkeypatch.setattr('alerts.realtime_switch.now_ms', lambda: stamp)
    with database.begin() as db:
        sid = source_id(db, revision)
        pref = db.get(Preference, 'managed_realtime:' + sid)
        if pref:
            db.delete(pref)
            db.flush()
        db.get(Instrument, sid).enabled = False
        if consumer in ('chart', 'expired'):
            db.add(MarketDemand(id='migration-lease', instrument_id=db.get(MarketComposite, composite).instrument_id,
                composite_revision_id=revision, expires=stamp + (60000 if consumer == 'chart' else -1)))
        elif consumer == 'alert':
            from alerts.storage import ChartAlertVersion
            rule = ChartAlert(request_id='legacy-running', request_hash='fixture', name='existing',
                status='active', version=1, effective_at=stamp)
            db.add(rule)
            db.flush()
            db.add(ChartAlertVersion(alert_id=rule.id, version=1, effective_at=stamp,
                config={'series_kind': 'composite'}, market_identity={'composite_revision_id': revision}))
        db.flush()
        assert enabled(db, sid) is (consumer in ('chart', 'alert'))


def test_http_switch_is_strict_idempotent_and_does_not_authorize_history(database, monkeypatch):
    monkeypatch.setattr('alerts.market_data.now_ms', lambda: START)
    api.app.dependency_overrides[api.authenticated] = lambda: 'test'
    try:
        with TestClient(api.app) as client:
            payload = {'instrument': 'BTCUSDT', 'enabled': False}
            first = client.post('/api/market-data/realtime', json=payload)
            assert first.status_code == 200, first.text
            assert not first.json()['realtime_enabled']
            second = client.post('/api/market-data/realtime', json=payload)
            assert second.json() == first.json()
            assert client.get('/api/market-data/realtime', params={'instrument': 'BTCUSDT'}).json() == first.json()
            assert client.post('/api/market-data/realtime', json={**payload, 'enabled': 'false'}).status_code == 422
            assert client.post('/api/market-data/realtime', json={**payload, 'instrument': 'missing'}).status_code == 422
            with database() as db:
                assert db.scalar(select(func.count()).select_from(ChartHistoryPlan)) == 0
                assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
                assert db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == 'managed_realtime_changed')) == 1
                assert not enabled(db, 'BTCUSDT')
            assert client.post('/api/market-data/realtime', json={**payload, 'enabled': True}).json()['realtime_enabled']
    finally:
        api.app.dependency_overrides.clear()


@pytest.mark.parametrize('existing', [True, False])
def test_history_join_and_progress_preserve_explicit_off(database, existing):
    stamp = START + 30 * 60000 + 5000
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        if existing:
            join(db, inst, START, stamp)
        set_enabled(db, inst.id, False, now=stamp)
        plan = join(db, inst, START - 86400000, stamp)
        assert not plan.realtime_enabled and not inst.enabled
        assert advance_plan(db, plan, stamp)
        job = db.scalar(select(ImportJob))
        assert job and job.priority == 300 and job.status == 'pending'
        assert plan.status == 'pending' and not enabled(db, inst.id)


def test_composite_compatibility_and_off_remove_live_targets_but_keep_history(database, monkeypatch):
    _, composite, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        sid = source_id(db, revision)
        assert not db.get(Instrument, sid).enabled
        assert enabled(db, sid), 'existing on-demand composite remains usable'
        row = db.get(MarketComposite, composite)
        renew_demand(db, 'old-chart', db.get(Instrument, row.instrument_id), composite_revision_id=revision)
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
        assert composite_targets(db, wanted_instruments(db)) == {target}
        query = DataQuery(instrument=composite, series_kind='composite', timeframe='M1',
                          provisional=False, client='history-reader')
        before = chart_data(db, query)
        set_enabled(db, sid, False, now=stamp)
        assert composite_targets(db, wanted_instruments(db)) == set()
        renew_demand(db, 'new-chart', db.get(Instrument, row.instrument_id), composite_revision_id=revision)
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 2
        after = chart_data(db, query)
        assert before['bars'] == after['bars'] and before['input_revision'] == after['input_revision']
        assert not live_snapshot(db, db.get(CompositeRevision, revision), now=stamp)['sample_ready']
        facts = status(db, sid, now=stamp)
        assert facts['history_available'] and not facts['realtime_enabled']
        assert not facts['composites'][0]['alert_eligible']


def test_disabled_composite_never_captures_provisional_snapshot(database, monkeypatch):
    _, composite, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        set_enabled(db, source_id(db, revision), False, now=stamp)
        fixed = chart_data(db, DataQuery(instrument=composite, series_kind='composite', timeframe='M1', provisional=False))
        def forbidden(*args, **kwargs):
            pytest.fail('disabled live chart attempted display capture')
        monkeypatch.setattr('alerts.display_snapshots.capture', forbidden)
        page = chart_data(db, DataQuery(instrument=composite, series_kind='composite', timeframe='M1', provisional=True))
        assert page['bars'] == fixed['bars']
        assert db.scalar(select(DisplaySnapshot)) is None
        with pytest.raises(ValueError, match='实时流已关闭'):
            chart_data(db, DataQuery(instrument=composite, series_kind='composite', timeframe='M1',
                                    provisional=True, display_snapshot_id='a' * 64))


@pytest.mark.parametrize('action', ['resume', 'restart', 'rebaseline'])
def test_disabled_rules_reject_create_and_resume_without_mutating_counters(database, monkeypatch, action):
    ident, composite, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        row = db.get(ChartAlert, ident)
        row.status, row.health = 'paused', 'blocked'
        row.count = 2
        set_enabled(db, source_id(db, revision), False, now=stamp)
        before = (row.run, row.count, row.status, row.control_revision, copy.deepcopy(row.state))
        with pytest.raises(ValueError, match='实时流已关闭'):
            create(db, 'disabled-rule', config(composite), at=stamp)
        with pytest.raises(ValueError, match='实时流已关闭'):
            lifecycle(db, ident, row.version, action, expected_revision=row.control_revision,
                      request_id='blocked-' + action, at=stamp)
        assert (row.run, row.count, row.status, row.control_revision, row.state) == before
        assert db.scalar(select(ChartAlertAction)) is None


def test_running_rule_pauses_once_off_and_reenable_needs_explicit_resume(database, monkeypatch):
    ident, _, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        row = db.get(ChartAlert, ident)
        before = (row.version, row.run, row.count, copy.deepcopy(row.state), copy.deepcopy(row.runtime))
        control = row.control_revision
        sid = source_id(db, revision)
        set_enabled(db, sid, False, now=stamp)
        assert evaluate(db, ident, now=stamp + 1) == []
        assert row.status == 'paused' and row.control_revision == control + 1
        assert '实时流已关闭' in row.health_reason
        assert evaluate(db, ident, now=stamp + 2) == [] and row.control_revision == control + 1
        set_enabled(db, sid, True, now=stamp + 3)
        assert row.status == 'paused' and evaluate(db, ident, now=stamp + 3) == []
        assert (row.version, row.run, row.count, row.state, row.runtime) == before
        assert db.scalar(select(SignalRow)) is None
        expected = row.control_revision
        lifecycle(db, ident, row.version, 'resume', expected_revision=expected, request_id='explicit', at=stamp + 3)
        assert row.status == 'active'
        set_enabled(db, sid, False, now=stamp + 4)
        lifecycle(db, ident, row.version, 'resume', expected_revision=expected, request_id='explicit', at=stamp + 4)
        assert db.scalar(select(func.count()).select_from(ChartAlertAction)) == 1


@pytest.mark.parametrize('mode', ['close', 'intrabar'])
def test_stale_input_pauses_without_event_or_automatic_recovery(database, monkeypatch, mode):
    ident, _, revision, _, stamp = armed(database, monkeypatch, mode=mode)
    with database.begin() as db:
        evaluate(db, ident, now=stamp)
        assert evaluate(db, ident, now=stamp + 15001) == []
        row = db.get(ChartAlert, ident)
        assert row.status == 'paused' and '过期' in row.health_reason
        assert db.scalar(select(SignalRow)) is None
    live(database, revision, stamp + 16000, stamp - 10)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp + 16000) == []
        assert db.get(ChartAlert, ident).status == 'paused'


def test_stale_creation_is_rejected(database, monkeypatch):
    _, composite, _, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        with pytest.raises(ValueError, match='尚未就绪'):
            create(db, 'late-create', config(composite), at=stamp + 15001)


@pytest.mark.parametrize('gap', ['preparation', 'period'])
def test_alert_admission_requires_prepared_seam_and_period(database, monkeypatch, gap):
    _, composite, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        if gap == 'preparation':
            db.get(CompositePreparation, revision).status = 'pending'
        else:
            from alerts.storage import CompositeAggregateTask
            db.delete(db.get(CompositeAggregateTask, (revision, 'M1')))
        with pytest.raises(ValueError, match='接缝或告警周期'):
            create(db, 'not-ready-' + gap, config(composite), at=stamp)


def test_expired_input_pauses_even_while_preparation_is_pending(database, monkeypatch):
    ident, _, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        db.get(CompositePreparation, revision).status = 'pending'
        assert evaluate(db, ident, now=stamp + 15001) == []
        assert db.get(ChartAlert, ident).status == 'paused'


def test_known_closed_session_does_not_pause_on_old_input(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch)
    # Session evidence itself is covered by test_live_session. Exercise the
    # evaluator's closed-session boundary, independently of the synthetic date.
    monkeypatch.setattr('alerts.live_session.session_status', lambda *args: {
        'market_session': 'closed', 'calendar_verified': True})
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp + 15001) == []
        assert db.get(ChartAlert, ident).status == 'active'
        assert '闭市' in db.get(ChartAlert, ident).health_reason


def test_rest_candle_freshness_does_not_require_a_quote(database, monkeypatch):
    ident, composite, revision, _, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
        state = db.get(LiveState, target)
        state.quote = {}
        state.forming = {'acquisition_mode': 'rest_batch', 'close': '1.11', 'connection_epoch': state.epoch}
        assert create(db, 'fresh-rest', config(composite), at=stamp)
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).status == 'active'
        assert evaluate(db, ident, now=stamp + 15001) == []
        assert db.get(ChartAlert, ident).status == 'paused'


def test_capability_reports_stale_source_unavailable(database, monkeypatch):
    from alerts.chart_alert_application import CapabilityQuery, capabilities
    _, composite, _, _, stamp = armed(database, monkeypatch)
    monkeypatch.setattr('alerts.composite_quotes.now_ms', lambda: stamp + 15001)
    result = capabilities(CapabilityQuery(instrument=composite, series_kind='composite', timeframe='M1'))
    assert result['sources'][0]['available'] is False


def test_compatibility_snapshot_survives_lease_expiry_and_repeated_bootstrap(database, monkeypatch):
    from alerts.realtime_switch import initialize_defaults
    composite, revision, _ = populated(database, monkeypatch)
    with database.begin() as db:
        sid = source_id(db, revision)
        db.delete(db.get(Preference, 'managed_realtime:' + sid))
        db.add(MarketDemand(id='pre-upgrade', instrument_id=db.get(MarketComposite, composite).instrument_id,
            composite_revision_id=revision, expires=START + 1000))
        db.flush()
        initialize_defaults(db, now=START)
        assert enabled(db, sid)
        db.get(MarketDemand, 'pre-upgrade').expires = 0
        initialize_defaults(db, now=START + 2000)
        assert enabled(db, sid)
        set_enabled(db, sid, False, now=START + 3000)
        initialize_defaults(db, now=START + 4000)
        assert not enabled(db, sid)


def test_ordinary_collection_and_repairs_skip_off_but_history_is_not_starved(database, monkeypatch):
    stamp = START + 30 * 60000 + 5000
    monkeypatch.setattr(market, 'now_ms', lambda: stamp)
    with database.begin() as db:
        for inst in db.scalars(select(Instrument)):
            inst.enabled = False
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, stamp)
        set_enabled(db, inst.id, False, now=stamp)
        db.add(MarketDemand(id='stale-viewer', instrument_id=inst.id, expires=stamp + 60000))
        db.add(ImportJob(instrument_id=inst.id, start=START, end=START + 60000, cursor=START, priority=0, next_at=stamp))
        db.add(ImportJob(instrument_id=inst.id, start=START - 60000, end=START, cursor=START - 60000, priority=50, next_at=stamp))
    def forbidden(*args, **kwargs):
        pytest.fail('disabled realtime job reached supplier')
    market.once(include_viewers=True, fetcher=forbidden)
    assert not market.import_once(realtime_only=True, fetcher=forbidden)
    calls = []
    def history(*args, **kwargs):
        calls.append(args)
        raise TimeoutError('fixture history request reached supplier')
    assert market.import_once(history_only=True, fetcher=history)
    assert len(calls) == 1
