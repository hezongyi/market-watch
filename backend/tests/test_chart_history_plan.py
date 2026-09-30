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
