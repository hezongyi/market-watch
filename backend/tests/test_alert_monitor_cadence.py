from threading import Event

import pytest
from alerts import alert_monitor, chart_alert_worker, composite_watches


@pytest.mark.parametrize('cost,expected', [(.3, [0, 1, 2]), (1.3, [0, 2, 4])])
def test_shared_monitor_deadlines_include_watch_and_coalesce_overruns(monkeypatch, cost, expected):
    stop = Event()
    clock, starts, watches, reports = [0.0], [], [], []

    def step(**kwargs):
        starts.append(clock[0])
        clock[0] += cost / 2

    def watch():
        watches.append(clock[0])
        clock[0] += cost / 2

    def wait(seconds):
        assert seconds > 0, 'No catch-up storm or overloaded busy loop'
        clock[0] += seconds
        if len(starts) == 3:
            stop.set()

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    monkeypatch.setattr(composite_watches, 'step', watch)
    monkeypatch.setattr(stop, 'wait', wait)
    alert_monitor.run(stop, monotonic=lambda: clock[0], on_turn=reports.append)
    assert starts == expected
    assert len(watches) == 3
    assert all(row['overrun'] == (cost > 1) for row in reports)


def test_monitor_errors_back_off_without_running_watch(monkeypatch):
    stop, clock, turns = Event(), [0.0], []

    def failed(**kwargs):
        raise ValueError('test failure')

    def watch():
        pytest.fail('Failed chart round must not start watch')

    def wait(seconds):
        assert seconds >= 1
        stop.set()

    monkeypatch.setattr(chart_alert_worker, 'step', failed)
    monkeypatch.setattr(composite_watches, 'step', watch)
    monkeypatch.setattr(stop, 'wait', wait)
    alert_monitor.run(stop, monotonic=lambda: clock[0], on_turn=turns.append)
    assert turns[0]['error'] == 'ValueError'


def test_each_alert_uses_its_read_time_and_reports_committed_state(database, monkeypatch):
    from alerts.chart_alert_service import AlertConfig, create
    from alerts.storage import ChartAlert
    from test_chart_alert_worker import config

    with database.begin() as db:
        ids=[create(db,'monitor-clock-'+str(i),AlertConfig.model_validate(config()),at=1000).id
             for i in range(2)]
    seen, reports = [], []
    clock=iter([2000,3000])
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
    assert seen==[2000,3000] and {row['alert_id'] for row in reports}==set(ids)


def test_observer_failure_does_not_rewrite_committed_health(database,monkeypatch):
    from alerts.chart_alert_service import create
    from alerts.storage import ChartAlert
    from test_chart_alert_worker import config
    with database.begin() as db:
        ident=create(db,'observer-error',config(),at=1000).id
    def evaluate(db,ident,**kwargs):
        db.get(ChartAlert,ident).health='ready'
    def observe(row):
        raise RuntimeError('Evidence sink unavailable')
    monkeypatch.setattr(chart_alert_worker,'evaluate',evaluate)
    with pytest.raises(RuntimeError,match='Evidence sink'):
        chart_alert_worker.step(on_evaluated=observe)
    with database.begin() as db:
        assert db.get(ChartAlert,ident).health=='ready'
