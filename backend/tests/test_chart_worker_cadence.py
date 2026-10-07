import pytest
from alerts import chart_history_worker as worker


def test_history_replans_between_pages_without_maintenance_delay(monkeypatch):
    events=[]
    monkeypatch.setattr(worker.time,'monotonic',lambda:100000)
    monkeypatch.setattr(worker,'refresh_catalog',lambda:events.append('catalog'))
    monkeypatch.setattr(worker,'advance_pending_plans',lambda:events.append('plan'))
    monkeypatch.setattr(worker,'import_once',lambda **kwargs:events.append('page') or True)
    def sleep(seconds):
        events.append(seconds)
        if events.count('page')==3:
            raise SystemExit
    monkeypatch.setattr(worker.time,'sleep',sleep)
    with pytest.raises(SystemExit):
        worker.run(lambda *args:None)
    assert events==['catalog','plan','page',0.2,'plan','page',0.2,'plan','page',0.2]


def test_old_manual_queue_drained_before_plan_work_and_realtime_excluded(monkeypatch):
    calls=[]
    monkeypatch.setattr(worker.time,'monotonic',lambda:100000)
    for name in ('refresh_catalog','advance_pending_plans'):
        monkeypatch.setattr(worker,name,lambda:None)
    def imported(**kwargs):
        calls.append(kwargs.get('chart_only',False))
        assert kwargs['defer_aggregation'] is True
        assert kwargs['history_only'] is True
        return len(calls)==1 or kwargs.get('chart_only',False)
    monkeypatch.setattr(worker,'import_once',imported)
    def sleep(seconds):
        if len(calls)>=3:
            raise SystemExit
    monkeypatch.setattr(worker.time,'sleep',sleep)
    with pytest.raises(SystemExit):
        worker.run(lambda *args:None)
    assert calls==[False,False,True]


@pytest.mark.parametrize("publication_pending,expected_sleep", [(True, 0.02), (False, 2)])
def test_publication_rotation_does_not_sleep_as_an_idle_worker(monkeypatch, publication_pending, expected_sleep):
    from alerts import chart_aggregation_worker as publisher

    monkeypatch.setattr(publisher, "aggregate_once", lambda: False)
    monkeypatch.setattr(publisher, "publish_once", lambda: publication_pending)
    delays = []
    def sleep(seconds):
        delays.append(seconds)
        raise SystemExit
    from alerts.publication_wakeup import PublicationWakeup
    monkeypatch.setattr(PublicationWakeup, "prepare", lambda self: None)
    monkeypatch.setattr(PublicationWakeup, "wait", lambda self, seconds: sleep(seconds))
    with pytest.raises(SystemExit):
        publisher.main()
    assert delays == [expected_sleep], "live publication work is not an empty aggregation queue"


@pytest.mark.parametrize('worked,result,delay', [
    (False, dict(runnable_remaining=True), .005),
    (False, dict(runnable_remaining=True, blocked_reason='ValueError', attempted=True), .005),
    (False, dict(task_progressed=True), .02),
    (True, {}, .02),
    (False, dict(blocked_reason='ValueError', next_due_at=3000), 2),
    (False, dict(blocked_reason='locked', next_due_at=1100), .1),
    (False, dict(next_due_at=1500), .5),
    (False, {}, 2),
])
def test_short_wait_requires_confirmed_ready_publication(worked, result, delay, monkeypatch):
    from alerts import chart_aggregation_worker as publisher
    from alerts import storage
    from alerts.publication_result import PublicationResult
    monkeypatch.setattr(storage, 'now_ms', lambda: 1000)
    assert publisher.wait_seconds(worked, PublicationResult(**result)) == delay


def test_cycle_optional_observer_reports_separate_call_boundaries(monkeypatch):
    from alerts import chart_aggregation_worker as publisher
    from alerts import publication_budget
    from alerts.publication_result import PublicationResult
    ticks = iter((1., 2., 3., 4., 5.))
    monkeypatch.setattr(publisher.time, 'monotonic', lambda: next(ticks))
    result = PublicationResult(task_progressed=True, runnable_remaining=True,
                               selected_target=('EURUSD', 'M1'), attempted=True)
    monkeypatch.setattr(publisher, 'publish_once', lambda: result)
    monkeypatch.setattr(publisher, 'aggregate_once', lambda: True)
    observations = []
    def observe(row):
        assert publication_budget.current() is None
        observations.append(row)
    assert publisher.cycle(observer=observe) == (True, result)
    assert observations == [dict(publication_started=2., publication_finished=3.,
        publication_result=result, aggregation_started=4., aggregation_finished=5.,
        aggregation_result=True)]
