import pytest
from alerts import composite_recheck as module
from alerts import composite_preparation as preparation
from alerts.storage import CompositeInputEvent, CompositePreparation, CompositeRevision, CompositeReadAttempt, SourceMinuteRevision
from sqlalchemy import select
from test_composite_preparation import ready, answer
from test_market_contracts import minute


def test_recheck_is_bounded_idempotent_and_keeps_empty_minutes_unknown(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(module, 'now_ms', lambda: 165725000)
    ownership = preparation.claim(revision_id)
    preparation.commit(ownership, answer(ownership, rows=(), result={'status':'empty_success'}))
    with database.begin() as db:
        revision=db.get(CompositeRevision,revision_id)
        composite_id=revision.composite_id
    calls=[]
    def source(adapter,identity,start,end,**kwargs):
        calls.append((start,end))
        return answer(ownership, rows=(), result={'status':'empty_success'})
    monkeypatch.setattr('alerts.source_history_store.shared_page',source)
    body=dict(request_id='one',start=ownership['start'],end=ownership['end'])
    result=module.recheck(composite_id,revision_id,body,object())
    assert result['accepted'] and result['observations']==0 and 'unknown' in result['coverage']
    assert module.recheck(composite_id,revision_id,body,object())==result and len(calls)==1
    with pytest.raises(ValueError,match='间隔'):
        module.recheck(composite_id,revision_id,{**body,'request_id':'two'},object())
    with database.begin() as db:
        assert db.get(CompositePreparation,revision_id).input_revision==0
        assert db.scalar(select(CompositeInputEvent)) is None
    with pytest.raises(ValueError,match='24小时'):
        module.RecheckRequest(**{**body,'end':body['start']+86460000})


def test_recheck_applies_real_observations_to_same_revision_without_activation(database, monkeypatch):
    revision_id=ready(database,monkeypatch)
    monkeypatch.setattr(module,'now_ms',lambda:165725000)
    ownership=preparation.claim(revision_id)
    preparation.commit(ownership,answer(ownership,rows=(),result={'status':'empty_success'}))
    with database.begin() as db:
        composite_id=db.get(CompositeRevision,revision_id).composite_id
    monkeypatch.setattr('alerts.source_history_store.shared_page',lambda *a,**kw:answer(ownership,rows=(minute(ownership['start'],volume='3'),)))
    result=module.recheck(composite_id,revision_id,dict(request_id='minute',start=ownership['start'],end=ownership['end']),object())
    assert result['accepted'] and result['observations']==1
    with database.begin() as db:
        assert db.get(CompositePreparation,revision_id).input_revision==1
        assert db.get(CompositeRevision,revision_id).activated_at is None
        assert db.scalar(select(CompositeInputEvent)).input_manifest['reason']=='gap_recheck'


@pytest.mark.parametrize('covered', ['observed', 'target_closure', 'history_closure'])
def test_recheck_targets_unknown_minutes_before_spending_quota(database, monkeypatch, covered):
    from alerts.config import settings
    from alerts.market_datasets import register_dataset
    from test_market_contracts import identity
    from datetime import datetime, timezone

    # Register reviewed calendar identities before binding/publication. Existing
    # dataset metadata and published manifests remain immutable in this test too.
    profile = {'revision': 'synthetic-reviewed', 'closures': [{
        'start': datetime.fromtimestamp(0, timezone.utc).isoformat(),
        'end': datetime.fromtimestamp(300000000 / 1000, timezone.utc).isoformat(),
        'source': 'https://example.com/acceptance-closure', 'reason': 'synthetic test proof'}]}
    selected = identity()
    if covered == 'target_closure':
        from alerts.history_catalog import account_scope
        monkeypatch.setattr(settings, 'oanda_account_id', 'composite-test-account')
        selected = identity(source='oanda', channel='v20', environment='practice',
            account_scope=account_scope(), provider_symbol='EUR_USD')
    profile['source_session'] = {**{key: getattr(selected, key) for key in (
        'source', 'channel', 'environment', 'provider_symbol', 'account_scope')},
        'timezone': 'UTC', 'reviewed_start': profile['closures'][0]['start'],
        'reviewed_end': profile['closures'][0]['end'], 'weekly_closures': [],
        'evidence_url': 'https://example.com/acceptance-session', 'applicability': 'Synthetic fixture identity only'}
    if covered == 'target_closure':
        monkeypatch.setattr(settings, 'oanda_calendar_version', profile['revision'])
        monkeypatch.setattr(settings, 'oanda_calendar_profiles', {'EUR_USD': profile})
    elif covered == 'history_closure':
        def historical(db):
            return register_dataset(db, identity(calendar_version=profile['revision']), logical_symbol='EURUSD',
                label='EURUSD', calendar='ny17', precision=5, volume_kind='quantity',
                volume_unit='source_quantity', calendar_profile=profile)
        # Preserve the fixture's selected history identity while attaching proof
        # to its source segment, rather than mutating a bound calendar.
        profile['revision'] = identity().calendar_version
        monkeypatch.setattr('test_composite_definitions.register', historical)
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(module, 'now_ms', lambda: 165725000)
    ownership = preparation.claim(revision_id)
    start, end = ownership['start'], ownership['start'] + 60000
    preparation.commit(ownership, answer(ownership,
        rows=(minute(start, volume='3'),) if covered == 'observed' else (),
        result={'status': 'data' if covered == 'observed' else 'empty_success'}))
    with database.begin() as db:
        composite_id = db.get(CompositeRevision, revision_id).composite_id
    calls = []
    def source(*args, **kwargs):
        calls.append(1)
        return answer({**ownership, 'start': start, 'end': end}, rows=(), result={'status': 'empty_success'})
    monkeypatch.setattr('alerts.source_history_store.shared_page', source)
    body = dict(request_id='covered', start=start, end=end)
    if covered == 'history_closure':
        assert module.recheck(composite_id, revision_id, body, object())['accepted']
        assert len(calls) == 1, 'historical-source closure does not certify target minutes'
    else:
        with pytest.raises(ValueError, match='未知分钟'):
            module.recheck(composite_id, revision_id, body, object())
        assert not calls
        with database.begin() as db:
            assert not list(db.scalars(select(CompositeReadAttempt).where(
                CompositeReadAttempt.read_kind == 'gap_recheck'))), 'rejected window spends no quota'


def test_successful_recheck_can_be_retried_after_its_gap_is_filled(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(module, 'now_ms', lambda: 165725000)
    ownership = preparation.claim(revision_id)
    preparation.commit(ownership, answer(ownership, rows=(), result={'status': 'empty_success'}))
    with database.begin() as db:
        composite_id = db.get(CompositeRevision, revision_id).composite_id
    body = dict(request_id='fill-once', start=ownership['start'], end=ownership['start'] + 60000)
    calls = []
    def source(*args, **kwargs):
        calls.append(1)
        return answer({**ownership, 'end': body['end']}, rows=(minute(body['start'], volume='3'),))
    monkeypatch.setattr('alerts.source_history_store.shared_page', source)
    result = module.recheck(composite_id, revision_id, body, object())
    assert result['accepted'] and result['observations'] == 1
    assert module.recheck(composite_id, revision_id, body, object()) == result
    with pytest.raises(ValueError, match='未知分钟'):
        module.recheck(composite_id, revision_id, {**body, 'request_id': 'already-filled'}, object())
    assert len(calls) == 1


@pytest.mark.parametrize('failure', ['rate_limited', 'unauthorized', 'configuration', 'identity', 'window', 'expired'])
def test_failed_or_obsolete_rechecks_never_register_source_or_composite_prices(database, monkeypatch, failure):
    from test_market_contracts import identity

    revision_id = ready(database, monkeypatch)
    stamp = [165725000]
    monkeypatch.setattr(module, 'now_ms', lambda: stamp[0])
    ownership = preparation.claim(revision_id)
    preparation.commit(ownership, answer(ownership, rows=(), result={'status': 'empty_success'}))
    with database.begin() as db:
        composite_id = db.get(CompositeRevision, revision_id).composite_id

    def source(*args, **kwargs):
        if failure == 'configuration':
            from alerts.history_sources import HistoryConfigurationError
            raise HistoryConfigurationError('No acceptance provider credentials')
        if failure in ('rate_limited', 'unauthorized'):
            return answer(ownership, rows=(), result={'status': failure})
        if failure == 'identity':
            return answer(ownership, identity=identity(basis='ask'))
        if failure == 'window':
            return answer(ownership, window_start=ownership['start'] - 60000)
        stamp[0] += 60000
        return answer(ownership)

    monkeypatch.setattr('alerts.source_history_store.shared_page', source)
    body = dict(request_id='failure', start=ownership['start'], end=ownership['end'])
    result = module.recheck(composite_id, revision_id, body, object())
    expected = {'configuration': 'configuration_error', 'identity': 'invalid_payload', 'window': 'invalid_payload', 'expired': 'timeout'}.get(failure, failure)
    assert result['status'] == expected and not result['accepted']
    assert module.recheck(composite_id, revision_id, body, object()) == result
    with database.begin() as db:
        assert db.get(CompositePreparation, revision_id).input_revision == 0
        assert db.scalar(select(SourceMinuteRevision)) is None
        assert db.scalar(select(CompositeInputEvent)) is None
        attempt = db.get(CompositeReadAttempt, result['request_id'])
        assert attempt.finished_at is not None and attempt.read_kind == 'gap_recheck'


def test_recheck_http_requires_authentication_and_closes_source_adapter(database, monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from alerts.composite_api import router

    authorized = [False]
    def authenticate():
        if not authorized[0]:
            raise HTTPException(401, 'Authentication required')

    calls = []
    class Source:
        def __init__(self):
            calls.append('open')
        def close(self):
            calls.append('close')

    monkeypatch.setattr('alerts.history_sources.HistorySources', Source)
    app = FastAPI()
    app.include_router(router(authenticate))
    with TestClient(app) as client:
        body = dict(request_id='http', start=0, end=60000)
        url = '/api/market-data/composites/missing/revisions/missing/recheck'
        assert client.post(url, json=body).status_code == 401 and not calls
        authorized[0] = True
        assert client.post(url, json={**body, 'end': 86460000}).status_code == 422 and not calls
        assert client.post(url, json=body).status_code == 422
        assert calls == ['open', 'close']


def test_abandoned_attempt_expires_without_reissuing_or_accepting_prices(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(module, 'now_ms', lambda: 165725000)
    ownership = preparation.claim(revision_id)
    preparation.commit(ownership, answer(ownership, rows=(), result={'status': 'empty_success'}))
    body = dict(request_id='abandoned', start=ownership['start'], end=ownership['end'])
    with database.begin() as db:
        composite_id = db.get(CompositeRevision, revision_id).composite_id
        db.add(CompositeReadAttempt(id=preparation.read_id('gap:'+revision_id+':abandoned'),
            revision_id=revision_id, start=body['start'], end=body['end'],
            read_kind='gap_recheck', started_at=165665000))
    monkeypatch.setattr('alerts.source_history_store.shared_page', lambda *a, **kw: pytest.fail('Expired id must never reissue'))
    result = module.recheck(composite_id, revision_id, body, object())
    assert result['status'] == 'timeout' and not result['accepted'] and result['finished_at'] is not None
    assert module.recheck(composite_id, revision_id, body, object()) == result


def test_recheck_restores_same_fixed_alert_baseline_before_later_cross(database, monkeypatch):
    from alerts.chart_alert_service import current_version
    from alerts.chart_alert_worker import evaluate
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import ChartAlert, MarketDataset, RealtimeMapping, SignalRow
    from sqlalchemy import func
    from test_composite_alerts import armed, live, aggregate
    from test_fixed_indicators import add_tail
    from alerts.composite_chart import chart_page
    from test_market_contracts import batch

    ident, composite_id, revision_id, seam, stamp = armed(database, monkeypatch, timeframe="M5")
    aggregate(revision_id, 'M5')
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        version_before = current_version(db, db.get(ChartAlert, ident)).id
        assert db.get(ChartAlert, ident).health == 'ready'

    # An interrupted stream leaves an unobserved minute. The next observed
    # crossing must become a recovery baseline after the explicit source read.
    outage = seam + 640000
    live(database, revision_id, outage, seam + 600000, connected=False)
    with database.begin() as db:
        assert evaluate(db, ident, now=outage) == []
        assert db.get(ChartAlert, ident).health == 'stale'
    recovered_at = seam + 900010
    add_tail(database, revision_id, [minute(at, close='1.119', volume='3')
        for at in range(seam + 660000, seam + 900000, 60000)])
    aggregate(revision_id, 'M5')
    live(database, revision_id, recovered_at, seam + 900000)
    with database.begin() as db:
        assert evaluate(db, ident, now=recovered_at) == []
        assert db.scalar(select(SignalRow)) is None
        assert db.get(ChartAlert, ident).health == 'stale'
        gap = chart_page(db, composite_id, 'M5', revision_id=revision_id, count=1, now=recovered_at)['bars'][-1]
        assert not gap['coverage_complete'] and gap['unknown_minutes'] == 1
        assert gap['time_closed'] and gap['source_confirmed']
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        source_identity = DatasetIdentity.model_validate(target.identity)
        input_before = db.get(CompositePreparation, revision_id).input_revision
    monkeypatch.setattr(module, 'now_ms', lambda: recovered_at)
    source = batch(identity=source_identity, window_start=seam + 600000, window_end=seam + 660000,
                   observed_at=recovered_at, checkpoint=seam + 660000,
                   volume_kind='price_count', volume_unit='quotes',
                   rows=(minute(seam + 600000, close='1.119', volume='3'),))
    monkeypatch.setattr('alerts.source_history_store.shared_page', lambda *a, **kw: source)
    body = dict(request_id='recover-fixed-alert', start=source.window_start, end=source.window_end)
    result = module.recheck(composite_id, revision_id, body, object())
    assert result['accepted'] and result['observations'] == 1
    assert module.recheck(composite_id, revision_id, body, object()) == result
    aggregate(revision_id, 'M5')
    with database.begin() as db:
        assert db.get(CompositePreparation, revision_id).input_revision == input_before + 1
        restored = chart_page(db, composite_id, 'M5', revision_id=revision_id, count=1, now=recovered_at)['bars'][-1]
        assert restored['coverage_complete'] and restored['unknown_minutes'] == 0
        previous = chart_page(db, composite_id, 'M5', revision_id=revision_id,
                              input_revision=input_before, count=1, now=recovered_at)['bars'][-1]
        assert not previous['coverage_complete'] and previous['unknown_minutes'] == 1
        assert evaluate(db, ident, now=recovered_at) == []
        row = db.get(ChartAlert, ident)
        assert row.runtime['readiness']['last_outcome'] == 'recovery_baseline'
        assert current_version(db, row).id == version_before
        assert current_version(db, row).market_identity['composite_revision_id'] == revision_id
        assert db.scalar(select(SignalRow)) is None

    def next_period(start, close):
        add_tail(database, revision_id, [minute(at, close=close, volume='3')
            for at in range(start, start + 300000, 60000)])
        aggregate(revision_id, 'M5')
        live(database, revision_id, start + 300010, start + 300000)
    next_period(seam + 900000, '1.11')
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1200010) == []
    next_period(seam + 1200000, '1.119')
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 1500010)) == 1
        assert evaluate(db, ident, now=seam + 1500010) == []
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.get(ChartAlert, ident).count == 1
