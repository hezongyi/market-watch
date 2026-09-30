import pytest
from alerts import chart_history_worker as worker


def test_history_replans_between_pages_without_maintenance_delay(monkeypatch):
    events=[]
    monkeypatch.setattr(worker.time,'monotonic',lambda:100000)
    monkeypatch.setattr(worker,'refresh_catalog',lambda:events.append('catalog'))
    monkeypatch.setattr(worker,'advance_weekly_request',lambda:events.append('weekly'))
    monkeypatch.setattr(worker,'advance_pending_plans',lambda:events.append('plan'))
    monkeypatch.setattr(worker,'import_once',lambda **kwargs:events.append('page') or True)
    def sleep(seconds):
        events.append(seconds)
        if events.count('page')==3:
            raise SystemExit
    monkeypatch.setattr(worker.time,'sleep',sleep)
    with pytest.raises(SystemExit):
        worker.run(lambda *args:None)
    assert events==['catalog','weekly','plan','page',0.2,'plan','page',0.2,'plan','page',0.2]
