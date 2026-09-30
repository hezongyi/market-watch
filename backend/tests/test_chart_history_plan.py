from datetime import UTC, datetime

from alerts.chart_history_plan import history_start, priority_regions, update_demand
from alerts.storage import ChartHistoryPlan, ChartViewportDemand, Instrument, ms


def test_ny_dst_and_weekend_buckets(database):
    with database.begin() as db:
        inst = db.get(Instrument, 'XAUUSD')
        end = ms(datetime(2026, 3, 9, 21, tzinfo=UTC))
        # Monday close after US spring change: previous Friday opened Thursday
        # at 22 UTC; no invented weekend day counts toward the two bars.
        assert history_start(inst, 'D1', end, 2) == ms(datetime(2026, 3, 5, 22, tzinfo=UTC))


def test_plan_expands_and_survives_closed_viewport(database):
    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        args = dict(ident='pane1', instrument='EURUSD', timeframe='H1',
                    end=end, visible=10, focused=True, now=end)
        plan = update_demand(db, **args)
        initial = plan.target_start
        assert priority_regions(db, plan, end)[0][2] == 100
        update_demand(db, **{**args, 'visible': 5})
        assert plan.target_start == initial
        update_demand(db, **{**args, 'visible': 20})
        assert plan.target_start < initial
        target = plan.target_start
    with database.begin() as db:
        plan = db.get(ChartHistoryPlan, 'EURUSD')
        assert plan.target_start == target
        assert priority_regions(db, plan, end+46000) == [(target, end, 300)]
        # Expiry does not move target_end to the new wall clock.
        assert plan.target_end == end


def test_shared_plan_keeps_other_visible_windows(database):
    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        args = dict(instrument='EURUSD', timeframe='M5', end=end, visible=5, now=end)
        plan = update_demand(db, ident='pane1', focused=True, **args)
        update_demand(db, ident='pane2', focused=False, **args)
        db.get(ChartViewportDemand, 'pane1').expires = end
        assert priority_regions(db, plan, end)[0][2] == 110
        assert len(list(db.query(ChartHistoryPlan))) == 1


def test_scheduler_reuses_reservations_and_demotes_only_owned_jobs(database):
    from alerts.chart_history_plan import advance_plan
    from alerts.storage import ImportJob
    from sqlalchemy import select

    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        db.get(Instrument, 'EURUSD').source = 'oanda'
        plan = update_demand(db, ident='pane', instrument='EURUSD', timeframe='H1',
                             end=end, visible=5, focused=True, now=end)
        assert advance_plan(db, plan, end)
        first = db.scalar(select(ImportJob).where(ImportJob.chart_plan.is_(True)))
        assert first.priority == 100
        assert first.end - first.start <= 4000*60000
        # Second batch shares the first reservation, instead of downloading it again.
        assert advance_plan(db, plan, end)
        jobs = list(db.scalars(select(ImportJob).order_by(ImportJob.start)))
        assert jobs[0].end <= jobs[1].start
        repair = ImportJob(instrument_id='EURUSD', start=plan.target_start,
                           end=plan.target_start+60000, cursor=plan.target_start,
                           priority=0, next_at=end)
        db.add(repair)
        db.flush()
        advance_plan(db, plan, end+46000)
        assert first.priority == 300
        assert repair.priority == 0
        # Reopening restores active demand priority on the existing job.
        update_demand(db, ident='pane', instrument='EURUSD', timeframe='H1',
                      end=end, visible=5, focused=True, now=end+47000)
        advance_plan(db, plan, end+47000)
        assert first.priority == 100


def test_completed_coverage_finishes_plan_and_cancelled_plan_does_not_queue(database, monkeypatch):
    from alerts import market
    from alerts.chart_history_plan import advance_plan
    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        plan = update_demand(db, ident='pane', instrument='EURUSD', timeframe='H1',
                             end=end, visible=5, focused=True, now=end)
        monkeypatch.setattr(market, 'stored_coverage', lambda *args: [
            {'start': plan.target_start, 'end': plan.target_end}])
        assert not advance_plan(db, plan, end)
        assert plan.status == 'complete'
        plan.status = 'cancelled'
        monkeypatch.setattr(market, 'stored_coverage', lambda *args: [])
        assert not advance_plan(db, plan, end)


def test_calendar_boundary_scan_matches_minute_scan():
    from datetime import timedelta

    from alerts.calendar_profile import Closure
    from alerts.chart_history_plan import bucket_has_trading
    from alerts.domain import Calendar, has_trading_gap

    start = datetime(2026, 3, 5, 22, tzinfo=UTC)
    closures = (Closure(start=start, end=start+timedelta(hours=23,minutes=17),
                        reason='test',source='https://example.com/calendar'),)
    for hours in (1, 6, 24, 48, 96):
        right = start+timedelta(hours=hours)
        for gold in (False, True):
            assert bucket_has_trading(start,right,Calendar.NY17,gold,closures) == has_trading_gap(
                start,right,Calendar.NY17,gold=gold,closures=closures)


def test_plan_control_preserves_data_and_other_jobs(database):
    from alerts.chart_history_plan import advance_plan, control_plan, plan_status
    from alerts.storage import ImportJob
    from sqlalchemy import select

    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        plan = update_demand(db, ident='pane', instrument='EURUSD', timeframe='H1',
                             end=end, visible=5, focused=True, now=end)
        advance_plan(db,plan,end)
        owned = db.scalar(select(ImportJob).where(ImportJob.chart_plan.is_(True)))
        repair = ImportJob(instrument_id='EURUSD',start=1,end=2,cursor=1,priority=0)
        db.add(repair)
        db.flush()
        before = (plan.target_start,plan.target_end,owned.cursor)
        control_plan(db,'EURUSD','cancel',end)
        assert owned.status=='cancelled' and repair.status=='pending'
        assert plan_status(db,plan,end)['status']=='cancelled'
        control_plan(db,'EURUSD','resume',end+1)
        assert owned.status=='pending'
        assert before==(plan.target_start,plan.target_end,owned.cursor)
        owned.status='failed'
        owned.error='network'
        control_plan(db,'EURUSD','retry',end+2)
        assert owned.status=='pending' and owned.error is None


def test_plan_queue_is_bounded_while_scheduler_runs_each_page(database):
    from alerts.chart_history_plan import advance_plan
    from alerts.storage import ImportJob
    from sqlalchemy import func, select

    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        plan = update_demand(db, ident='pane', instrument='EURUSD', timeframe='D1',
                             end=end, visible=20, focused=True, now=end)
        assert advance_plan(db,plan,end)
        assert advance_plan(db,plan,end)
        for _ in range(5):
            assert not advance_plan(db,plan,end)
        assert db.scalar(select(func.count()).select_from(ImportJob).where(
            ImportJob.chart_plan.is_(True),ImportJob.status=='pending'))==2
        job=db.scalar(select(ImportJob).where(ImportJob.chart_plan.is_(True)))
        job.status='complete'
        job.cursor=job.end
        assert advance_plan(db,plan,end+1)


def test_new_foreground_displaces_deep_queue_without_losing_target(database):
    from alerts.chart_history_plan import advance_plan
    from alerts.storage import ImportJob
    from sqlalchemy import select

    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        plan = update_demand(db,ident='pane',instrument='EURUSD',timeframe='H1',
                             end=end,visible=5,focused=True,now=end)
        # Expire foreground and queue two deep pages away from the latest view.
        for i in range(2):
            left=plan.target_start+i*4000*60000
            db.add(ImportJob(instrument_id='EURUSD',start=left,end=left+4000*60000,
                cursor=left,priority=300,chart_plan=True,next_at=end))
        db.flush()
        target=plan.target_start
        assert advance_plan(db,plan,end)
        jobs=list(db.scalars(select(ImportJob).where(ImportJob.chart_plan.is_(True))))
        assert sum(j.status=='pending' for j in jobs)==2
        assert sum(j.status=='superseded' for j in jobs)==1
        assert any(j.priority==100 and j.status=='pending' for j in jobs)
        assert plan.target_start==target


def test_indicator_warmup_extends_current_period_without_inflating_daily_target(database):
    from alerts.chart_history_plan import history_start
    from alerts.storage import ChartViewportDemand
    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        inst=db.get(Instrument,'EURUSD')
        plan=update_demand(db,ident='pane',instrument='EURUSD',timeframe='H1',
            end=end,visible=20,required=200,focused=True,now=end)
        demand=db.get(ChartViewportDemand,'pane')
        assert demand.start==history_start(inst,'H1',end,200)
        assert plan.target_start==history_start(inst,'D1',end,60)


def test_resume_bounds_legacy_queue_and_prioritizes_current_view(database):
    from alerts.chart_history_plan import control_plan
    from alerts.storage import ImportJob

    end = ms(datetime(2026, 9, 28, 12, tzinfo=UTC))
    with database.begin() as db:
        plan = update_demand(db, ident='pane', instrument='EURUSD', timeframe='H1',
                             end=end, visible=5, focused=True, now=end)
        target = (plan.target_start, plan.target_end)
        jobs = []
        for offset in (20000, 16000, 12000, 4000):
            start = end - offset * 60000
            job = ImportJob(instrument_id='EURUSD', start=start, end=start+4000*60000,
                            cursor=start+60000, priority=300, chart_plan=True,
                            status='cancelled', next_at=end)
            db.add(job)
            jobs.append(job)
        db.flush()
        cursors = [job.cursor for job in jobs]
        control_plan(db, 'EURUSD', 'resume', end)
        assert sum(job.status == 'pending' for job in jobs) == 2
        assert jobs[-1].status == 'pending' and jobs[-1].priority == 100
        assert sum(job.status == 'superseded' for job in jobs) == 2
        assert [job.cursor for job in jobs] == cursors
        assert (plan.target_start, plan.target_end) == target
        # Repeated resume must not revive the deferred slices.
        control_plan(db, 'EURUSD', 'resume', end+1)
        assert sum(job.status == 'pending' for job in jobs) == 2
