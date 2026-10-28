from threading import Event

import pytest
from alerts import alert_monitor, chart_alert_worker


@pytest.mark.parametrize(
    'period,cost,expected',
    [(.75, .3, [0, .75, 1.5]), (.75, 1.3, [0, 1.5, 3]),
     (.25, .1, [0, .25, .5]), (.25, .3, [0, .5, 1.0])],
)
def test_chart_monitor_deadlines_coalesce_overruns(monkeypatch, period, cost, expected):
    stop = Event()
    clock, starts, reports = [0.0], [], []

    def step(**kwargs):
        starts.append(clock[0])
        clock[0] += cost

    def wait(seconds):
        assert seconds > 0, 'No catch-up storm or overloaded busy loop'
        clock[0] += seconds
        if len(starts) == 3:
            stop.set()

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    monkeypatch.setattr(stop, 'wait', wait)
    alert_monitor.run(stop, period=period, monotonic=lambda: clock[0], on_turn=reports.append,
                      report_health=lambda *args, **kwargs: None)
    assert starts == expected
    assert all(row['overrun'] == (cost > period) for row in reports)


@pytest.mark.parametrize('period', [.25, .75])
def test_monitor_errors_back_off(monkeypatch, period):
    stop, clock, turns = Event(), [0.0], []

    def failed(**kwargs):
        raise ValueError('test failure')

    def wait(seconds):
        assert seconds >= period
        stop.set()

    monkeypatch.setattr(chart_alert_worker, 'step', failed)
    monkeypatch.setattr(stop, 'wait', wait)
    alert_monitor.run(stop, period=period, monotonic=lambda: clock[0], on_turn=turns.append,
                      report_health=lambda *args, **kwargs: None)
    assert turns[0]['error'] == 'ValueError'


def test_each_alert_uses_its_read_time_and_reports_committed_state(database, monkeypatch):
    from alerts.chart_alert_service import AlertConfig, create
    from alerts.storage import ChartAlert
    from test_composite_alerts import ready_config

    config = ready_config(database, monkeypatch)
    stamp = config.at
    with database.begin() as db:
        ids=[create(db,'monitor-clock-'+str(i),AlertConfig.model_validate(config()),at=stamp).id
             for i in range(2)]
    seen, reports = [], []
    clock=iter([stamp+1000,stamp+2000])
    monkeypatch.setattr(chart_alert_worker,'now_ms',lambda:next(clock))

    def evaluate(db,ident,*,now,**kwargs):
        seen.append(now)
        db.get(ChartAlert,ident).state={'sequence':now}

    def committed(row):
        with database.begin() as db:
            assert db.get(ChartAlert,row['alert_id']).state['sequence']==row['sequence']
        assert row['read_started']<=row['commit_started']<=row['committed']
        reports.append(row)

    monkeypatch.setattr(chart_alert_worker,'evaluate',evaluate)
    chart_alert_worker.step(on_evaluated=committed)
    # 同一组合的多条规则共用一次锁后读取，整组报告同一个业务读时间。
    assert seen==[stamp+2000]*2 and {row['alert_id'] for row in reports}==set(ids)


def test_observer_failure_does_not_rewrite_committed_health(database,monkeypatch):
    from alerts.chart_alert_service import create
    from alerts.storage import ChartAlert
    from test_composite_alerts import ready_config
    config = ready_config(database, monkeypatch)
    stamp = config.at
    with database.begin() as db:
        ident=create(db,'observer-error',config(),at=stamp).id
    def evaluate(db,ident,**kwargs):
        db.get(ChartAlert,ident).health='ready'
    def observe(row):
        raise RuntimeError('Evidence sink unavailable')
    monkeypatch.setattr(chart_alert_worker,'evaluate',evaluate)
    with pytest.raises(RuntimeError,match='Evidence sink'):
        chart_alert_worker.step(on_evaluated=observe)
    with database.begin() as db:
        assert db.get(ChartAlert,ident).health=='ready'

def test_every_active_rule_is_evaluated_on_every_turn(database, monkeypatch):
    from alerts.chart_alert_service import AlertConfig, create
    from test_composite_alerts import ready_config

    make = ready_config(database, monkeypatch)
    with database.begin() as db:
        ids = [create(db, 'step-count-' + str(i), AlertConfig.model_validate(make()), at=make.at).id
               for i in range(2)]
    calls = []
    monkeypatch.setattr(chart_alert_worker, 'evaluate',
                        lambda db, ident, **kwargs: calls.append(ident))
    # 每轮都是完整判定：隐式跳过会让计数变 0，把 monitor 的空唤醒抑制错用到真判定上。
    assert chart_alert_worker.step() == 2
    assert chart_alert_worker.step() == 2
    assert calls == ids + ids
