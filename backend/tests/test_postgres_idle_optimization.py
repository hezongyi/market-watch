"""Real worker entry points retain prompt delivery while avoiding idle scans."""
from threading import Event

from alerts import notification_center_worker as notices
from alerts import publication_wakeup
from test_live_pricing import running as _running

running = _running


def test_normal_projection_turn_does_not_run_compatibility_history(database, monkeypatch):
    calls = []
    monkeypatch.setattr(notices, 'project', lambda db: calls.append('project') or 0)
    monkeypatch.setattr(notices, 'backfill', lambda db, **kw: calls.append('backfill') or 0)
    monkeypatch.setattr(notices, 'reconcile_channels', lambda db: calls.append('reconcile') or 0)
    notices.once(maintenance=False)
    assert calls == ['project']
    notices.once(maintenance=True)
    assert calls == ['project', 'project', 'backfill', 'reconcile']


def test_maintenance_drains_backlog_then_waits_a_minute(monkeypatch):
    clock, calls = [0.0], []
    results = iter([100, 0, 0, 0])
    monkeypatch.setattr(notices.time, 'monotonic', lambda: clock[0])
    def once(*, maintenance):
        calls.append(maintenance)
        return next(results)
    monkeypatch.setattr(notices, 'once', once)
    schedule = notices.ProjectionSchedule()
    assert schedule.once() == 100
    clock[0] = .02
    assert schedule.once() == 0
    clock[0] = 30
    assert schedule.once() == 0
    clock[0] = 61
    assert schedule.once() == 0
    assert calls == [True, True, False, True]


def test_long_idle_wait_falls_back_within_two_seconds_on_listener_failure(database):
    wake = publication_wakeup.PublicationWakeup()
    waits = []
    class Stop(Event):
        def wait(self, seconds):
            waits.append(seconds)
            return True
    assert wake.wait(30, Stop()) == 'stopped'
    assert waits == [2]


def test_live_listener_failure_also_caps_idle_fallback(database):
    wake = publication_wakeup.PublicationWakeup()
    class Broken:
        def notifies(self, **kw):
            raise OSError('listener disconnected')
        def close(self):
            pass
    wake.connection = Broken()
    waits = []
    class Stop(Event):
        def wait(self, seconds):
            waits.append(seconds)
            return False
    assert wake.wait(30, Stop()) == 'fallback'
    assert len(waits) == 1 and waits[0] <= 2


def test_confirmation_discovery_only_returns_due_data_and_keeps_commit_fence(running):
    from alerts import live_pricing as live
    from alerts.storage import LiveState, PricingOwner
    factory, owner, epoch, identities = running
    eur, gold = identities['EUR_USD'], identities['XAU_USD']
    with factory.begin() as db:
        db.get(LiveState, gold.key).next_confirm_at = 140000
    assert live.confirmation_candidates(identities, now=125000) == [eur]
    with factory.begin() as db:
        db.get(PricingOwner, owner[0]).expires = 0
    # Discovery is a hint; the real locked window must still reject a stale owner.
    import pytest
    with pytest.raises(TimeoutError):
        live.confirmation_window(owner, epoch, eur, now=125000)


def test_collector_handover_cache_is_populated_only_after_a_successful_commit(running, monkeypatch):
    from alerts import live_pricing as live
    from alerts import price_alert_inputs
    from test_live_pricing import quote
    factory, owner, epoch, identities = running
    eur = identities['EUR_USD']
    done = set()
    live.publish_event(owner, epoch, quote(eur, epoch), identities, now=125000, completed_handovers=done)
    assert eur.key not in done  # No prior quote to hand over on the first event.
    original = price_alert_inputs.record_quote
    def failure(*args, **kwargs):
        raise OSError('rollback quote')
    monkeypatch.setattr(price_alert_inputs, 'record_quote', failure)
    import pytest
    with pytest.raises(OSError):
        live.publish_event(owner, epoch, quote(eur, epoch, seq=2, source=122000), identities,
                           now=125000, completed_handovers=done)
    assert eur.key not in done
    monkeypatch.setattr(price_alert_inputs, 'record_quote', original)
    live.publish_event(owner, epoch, quote(eur, epoch, seq=2, source=122000), identities,
                       now=125000, completed_handovers=done)
    assert eur.key in done
    monkeypatch.setattr('alerts.display_observations.handover_legacy',
                        lambda *a: (_ for _ in ()).throw(AssertionError('repeated handover')))
    live.publish_event(owner, epoch, quote(eur, epoch, seq=3, source=123000), identities,
                       now=125000, completed_handovers=done)
    from alerts.storage import Instrument, LiveState, MarketDataset
    with factory() as db:
        assert db.get(LiveState, eur.key).quote['sequence'] == 3
        assert db.get(Instrument, db.get(MarketDataset, eur.key).instrument_id).last_received == 124000




def test_mapped_disabled_target_defers_derived_work_but_new_read_resumes(database, monkeypatch):
    import pytest
    from alerts import chart_aggregation_worker as worker
    from alerts import generic_derivation as generic
    from alerts.chart_aggregation import enqueue_aggregation
    from alerts.query_errors import QueryError
    from alerts.storage import (
        Bar,
        ChartAggregationJob,
        CompositeRevision,
        MarketDataset,
        MarketDemand,
        RealtimeMapping,
    )
    from sqlalchemy import select
    from test_composite_chart import populated
    _, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = target.instrument_id
        from alerts.realtime_switch import set_enabled
        set_enabled(db, ident, False, now=200000000)
        db.add(Bar(instrument_id=ident, timeframe='M1', start=seam, end=seam+60000,
            open=1, high=2, low=1, close=2, complete=True))
        enqueue_aggregation(db, ident, seam, seam+60000, 200000000)
    # Source input and dirty ranges survive, but no generic aggregate is executed.
    for _ in range(30):
        worker.cycle()
    with database() as db:
        assert db.scalar(select(ChartAggregationJob.id).where(ChartAggregationJob.instrument_id == ident))
        assert not db.scalar(select(Bar.id).where(Bar.instrument_id == ident, Bar.timeframe == 'M5'))
        assert ident in generic.paused_instruments(db)
    from alerts.chart_query import DataQuery, data_sync
    body = DataQuery(instrument=ident, timeframe='M5', limit=10)
    with pytest.raises(QueryError) as exc:
        data_sync(body)
    assert exc.value.status_code == 503
    with database() as db:
        assert db.scalar(select(MarketDemand.id).where(MarketDemand.instrument_id == ident))
        assert ident not in generic.paused_instruments(db)
    for _ in range(30):
        worker.cycle()
        with database() as db:
            if not generic.pending(db, ident, 'M5'):
                break
    else:
        pytest.fail('new independent read did not resume derivation')
    assert data_sync(body)['bars']
    with database() as db:
        from alerts.realtime_switch import enabled
        assert not enabled(db, ident), 'a derivation lease must not enable independent collection'
        assert db.scalar(select(Bar.id).where(Bar.instrument_id == ident, Bar.timeframe == 'M5'))


def test_idle_aggregation_keeps_future_retry_deadline(database, monkeypatch):
    from alerts import chart_aggregation_worker as worker
    from alerts import storage
    from alerts.storage import ChartAggregationJob
    monkeypatch.setattr(storage, 'now_ms', lambda: 1000000)
    with database.begin() as db:
        db.add(ChartAggregationJob(instrument_id='BTCUSDT', timeframe='M5',
            start=0, end=60000, created_at=0, attempts=1, next_at=1002000))
    worked, published = worker.cycle()
    assert not worked
    assert published.next_due_at == 1002000
    assert worker.wait_seconds(worked, published) == 2


def test_native_long_idle_is_interrupted_when_listener_disconnects(monkeypatch):
    from alerts import native_history_loads as loads
    from alerts import native_history_signals as signals
    connected, waits = [True], []
    monkeypatch.setattr(signals, 'healthy', lambda: connected[0])
    class Wake:
        def wait(self, seconds):
            waits.append(seconds)
            connected[0] = False
            return False
    loads._idle_wait(Event(), Wake(), 30)
    assert waits == [.5]


def test_native_pending_future_lease_is_not_classified_idle(database):
    from alerts import native_history_loads as loads
    from alerts.storage import NativeHistoryLoad
    assert not loads.pending_work()
    with database.begin() as db:
        db.add(NativeHistoryLoad(id='future', owner='test', request_id='future',
            query_json={}, state='waiting', deadline=9999999999999,
            consumer_until=9999999999999, lease_until=9999999999999))
    assert loads.pending_work()


def test_paused_ranges_coalesce_keep_retries_and_replay_corrected_extreme(database, monkeypatch):
    from alerts import generic_derivation as generic
    from alerts.chart_aggregation import enqueue_aggregation
    from alerts.chart_aggregation_worker import cycle
    from alerts.realtime_switch import set_enabled
    from alerts.storage import (
        Bar,
        ChartAggregationJob,
        CompositeRevision,
        MarketDataset,
        RealtimeMapping,
    )
    from sqlalchemy import select
    from test_composite_chart import populated
    _, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = target.instrument_id
        set_enabled(db, ident, False, now=200000000)
        for i, kind in enumerate(('price', 'observed', 'volume')):
            at = seam + i * 60000
            db.add(Bar(instrument_id=ident, timeframe='M1', start=at, end=at+60000,
                open=1, high=30 if i == 0 else 2, low=1, close=2, complete=True))
            enqueue_aggregation(db, ident, at, at+60000, 200000000+i, kind=kind)
            if i == 0:
                for job in db.scalars(select(ChartAggregationJob).where(ChartAggregationJob.instrument_id == ident)):
                    job.attempts, job.error = 2, 'previous_failure'
        jobs = list(db.scalars(select(ChartAggregationJob).where(ChartAggregationJob.instrument_id == ident)))
        assert len(jobs) == 5
        assert all((job.start, job.end, job.kind, job.created_at, job.attempts, job.error) ==
                   (seam, seam+180000, 'price', 200000000, 2, 'previous_failure') for job in jobs)
        generic.touch(db, ident)
    for _ in range(40):
        cycle()
        with database() as db:
            if not generic.pending(db, ident, 'M5'):
                break
    with database() as db:
        bars = list(db.scalars(select(Bar).where(Bar.instrument_id == ident, Bar.timeframe == 'M5')))
        assert bars and max(bar.high for bar in bars) == 30
        assert not generic.pending(db, ident, 'M5')


def test_unchanged_gap_is_not_rediscovered_but_fresh_input_requests_it(database, monkeypatch):
    from alerts import managed_dataset
    from alerts import publication_schedule as schedule
    from alerts.storage import ChartPublicationJob, ChartPublicationState
    monkeypatch.setattr(managed_dataset, 'adopt_legacy_once', lambda **kw: None)
    schedule._DISCOVER_AT.pop(database.kw['bind'], None)
    with database.begin() as db:
        db.add(ChartPublicationState(instrument_id='BTCUSDT', timeframe='M5',
            requested=1, processed=1, blocked_reason='gap'))
        db.add(ChartPublicationJob(instrument_id='BTCUSDT', timeframe='M5', start=0, end=300000))
    with database.begin() as db:
        schedule.discover(db, 1000000)
        state = db.get(ChartPublicationState, ('BTCUSDT', 'M5'))
        assert state.requested == state.processed == 1
        assert db.get(ChartPublicationJob, ('BTCUSDT', 'M5', 0)) is not None
        schedule.request(db, 'BTCUSDT', frames=('M5',), approved=True)
        db.refresh(state)
        assert state.requested == 2 and state.processed == 1
