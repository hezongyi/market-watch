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
