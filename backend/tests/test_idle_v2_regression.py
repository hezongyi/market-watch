"""Persistent worker cost regressions retain revision, quote and health semantics."""
import pytest
from alerts import composite_aggregates as aggregates
from alerts import runtime_health
from alerts.composite_realtime import CurrentBuckets
from alerts.storage import Instrument, MarketDataset, Preference, PricingOwner
from test_composite_chart import populated
from test_fixed_series_revisions import correction
from test_live_pricing import quote
from test_live_pricing import running as _running

running = _running


def drain(revision, frame, buckets):
    for _ in range(100):
        if not aggregates.aggregate_tick(revision, frame, realtime=buckets):
            return
    pytest.fail('aggregate queue did not drain')


@pytest.mark.parametrize('frame', ['M5', 'H4', 'W1', 'MN'])
def test_confirmed_worker_reuses_calendar_and_only_replaces_changed_inputs(database, monkeypatch, frame):
    _, revision, seam = populated(database, monkeypatch)
    buckets = CurrentBuckets(limit=32)
    drain(revision, frame, buckets)
    with database.begin() as db:
        correction(db, revision, seam + 60000, 200001000, '1.115')
    work = aggregates.claim(revision, frame)
    # Initial catch-up may span several M5 buckets and deliberately use the
    # authoritative multi-bucket path. Warm this selected bucket at input 1.
    aggregates.build(dict(work, input_revision=1), realtime=buckets)
    builds, delta_reads = buckets.builds, buckets.delta_reads
    expected = aggregates.build(work)
    def forbidden(*_):
        pytest.fail('warm confirmed aggregation rescanned bucket calendar')
    monkeypatch.setattr('alerts.composite_realtime._closed', forbidden)
    assert aggregates.build(work, realtime=buckets) == expected
    assert buckets.builds == builds and buckets.delta_reads == delta_reads + 1
    aggregates.commit(work, expected)


def test_confirmed_cache_cannot_leak_new_input_into_an_older_retry(database, monkeypatch):
    _, revision, seam = populated(database, monkeypatch)
    buckets = CurrentBuckets()
    drain(revision, 'MN', buckets)
    with database.begin() as db:
        correction(db, revision, seam + 60000, 200001000, '1.115')
    work = aggregates.claim(revision, 'MN')
    old = dict(work, input_revision=1)
    expected_old = aggregates.build(old)
    assert aggregates.build(work, realtime=buckets) == aggregates.build(work)
    assert aggregates.build(old, realtime=buckets) == expected_old
    assert aggregates.build(work, realtime=CurrentBuckets()) == aggregates.build(work)


def test_quotes_keep_display_freshness_without_rewriting_a_fresh_lease(running):
    from alerts import live_pricing as live
    factory, ownership, epoch, identities = running
    identity = identities['EUR_USD']
    with factory() as db:
        expiry = db.get(PricingOwner, ownership[0]).expires
        instrument = db.get(MarketDataset, identity.key).instrument_id
    for seq, at in enumerate([126000, 127000], 1):
        live.publish_event(ownership, epoch, quote(identity, epoch, seq=seq, source=at-1000), identities, now=at)
        with factory() as db:
            assert db.get(PricingOwner, ownership[0]).expires == expiry
            assert db.get(Instrument, instrument).last_received == at
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=3, source=149000), identities, now=150000)
    with factory() as db:
        assert db.get(PricingOwner, ownership[0]).expires > expiry
        assert db.get(Instrument, instrument).last_received == 150000


def test_background_health_coalesces_success_but_reports_fault_and_recovery(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(runtime_health, 'now_ms', lambda: clock[0])
    reporter = runtime_health.Progress('data', 'chart_history', 'boot')
    reporter.claim()
    reporter.record()
    clock[0] += 6000
    reporter.record(state='running')
    reporter.record(state='idle')
    with database() as db:
        value = db.get(Preference, runtime_health.key('chart_history')).value
        assert value['checked_at'] == 100000
        assert value['stale_after_ms'] >= 90000
    reporter.record(state='degraded', error='TimeoutError')
    with database() as db:
        assert db.get(Preference, runtime_health.key('chart_history')).value['error_type'] == 'TimeoutError'
    clock[0] += 1
    reporter.record()
    with database() as db:
        value = db.get(Preference, runtime_health.key('chart_history')).value
        assert value['error_type'] is None and value['checked_at'] == clock[0]


def test_empty_alert_monitor_backs_off_and_committed_hint_starts_next_scan(monkeypatch):
    from types import SimpleNamespace

    from alerts import alert_monitor, chart_alert_worker
    clock, scans, waits = [0.0], [], []
    stop = SimpleNamespace(is_set=lambda: len(scans) >= 3, wait=lambda seconds: clock.__setitem__(0, clock[0]+seconds))
    class Wake:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def prepare(self): pass
        def wait(self, seconds, _stop):
            waits.append(seconds)
            clock[0] += .01 if len(waits) == 1 else seconds
            return 'notification' if len(waits) == 1 else 'timer'
    def step(**kw):
        scans.append(clock[0])
        kw['activity']['active'] = len(scans) > 1
        return 1 if len(scans) > 1 else 0
    monkeypatch.setattr(chart_alert_worker, 'step', step)
    alert_monitor.run(stop, monotonic=lambda: clock[0], wakeup=Wake(), report_health=lambda *a, **kw: None)
    assert waits == pytest.approx([5, .25, .25])
    assert scans[1] == .01


def test_expired_pending_settlement_is_active_work(database, monkeypatch):
    from alerts import chart_alert_worker
    from alerts.storage import ChartAlert
    with database.begin() as db:
        db.add(ChartAlert(request_id='settlement-idle', request_hash='x', name='pending', effective_at=1,
            status='expired', runtime={'execution_contract': 'price-v2', 'settlement_pending': True}))
    # Exercise the durable selection while isolating evaluation/notification.
    monkeypatch.setattr(chart_alert_worker, 'current_version', lambda *a: (_ for _ in ()).throw(ValueError('fixture')))
    activity = {}
    chart_alert_worker.step(now=1000, activity=activity)
    assert activity == {'active': True}


def test_history_idle_scan_keeps_future_retries_fast(database):
    from alerts.chart_history_worker import pending_work
    from alerts.storage import ImportJob
    assert not pending_work()
    with database.begin() as db:
        db.add(ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0, next_at=10**15))
    assert pending_work()
