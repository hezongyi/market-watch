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
    monkeypatch.setattr(publisher.time, "sleep", sleep)
    with pytest.raises(SystemExit):
        publisher.main()
    assert delays == [expected_sleep], "live publication work is not an empty aggregation queue"
