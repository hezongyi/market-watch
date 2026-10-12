"""Actual import_page commit and publication must share one lock order."""
import os
import threading
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import event, select, func
from alerts import history_versions as history, managed_dataset, publication_schedule
from alerts.storage import ChartHistoryPlan, ChartPublicationState, HistoryChunk, HistoryVersion, Bar
from test_market_datasets import register
from test_market_contracts import identity
from test_history_maintenance import Adapter
from test_provider_postgres import provider_pg

pytestmark=pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'),reason='Requires isolated Ubuntu PostgreSQL')

@pytest.mark.parametrize('status',['pending','complete','cancelled'])
@pytest.mark.parametrize('realtime',[True,False])
def test_import_page_waits_without_inverse_lock_and_commits_once(provider_pg,monkeypatch,status,realtime):
    factory,engine=provider_pg
    monkeypatch.setattr(publication_schedule,'discover',lambda *_:None)
    monkeypatch.setattr(managed_dataset,'now_ms',lambda:125000)
    with factory.begin() as db:
        inst=register(db);instrument=inst.id
        version=history.create_version(db,identity().key,0,120000)
        db.add(ChartHistoryPlan(instrument_id=instrument,target_start=0,target_end=120000,
            cursor=120000,realtime_end=0,status=status,realtime_enabled=realtime))
        db.flush();publication_schedule.request(db,instrument,frames=('M1',),approved=True)
        db.get(ChartPublicationState,(instrument,'M1')).next_at=125000
    publisher_owned=threading.Event();import_attempted=threading.Event()
    def observe(conn,cursor,sql,params,context,many):
        if threading.current_thread().name.startswith('import') and publisher_owned.is_set() and 'FROM market_datasets' in sql and 'FOR UPDATE' in sql:
            import_attempted.set()
    def publish(db,inst,plan,frame,stamp):
        publisher_owned.set();assert import_attempted.wait(5)
        return managed_dataset.publish_frame(db,inst,plan,frame,stamp)
    event.listen(engine,'before_cursor_execute',observe)
    source_read=threading.Event()
    class InterleavedAdapter(Adapter):
        def page(self,*args):
            source_read.set()
            assert publisher_owned.wait(5)
            return super().page(*args)
    adapter=InterleavedAdapter()
    try:
        with ThreadPoolExecutor(1,thread_name_prefix='publisher') as a,ThreadPoolExecutor(1,thread_name_prefix='import') as b:
            imp=b.submit(history.import_page,adapter,version_id=version)
            assert source_read.wait(5)
            pub=a.submit(publication_schedule.tick,publish,managed_dataset.publish_corrections)
            assert pub.result(timeout=10).blocked_reason != 'OperationalError'
            assert imp.result(timeout=10)
        with factory() as db:
            assert db.get(HistoryVersion,version).status=='published'
            assert db.get(HistoryVersion,version).cursor==120000
            assert db.scalar(select(func.count()).select_from(HistoryChunk))==1
            assert db.scalar(select(func.count()).select_from(Bar).where(Bar.instrument_id==instrument))==2
        assert adapter.calls==[(0,120000)]
    finally:event.remove(engine,'before_cursor_execute',observe)
