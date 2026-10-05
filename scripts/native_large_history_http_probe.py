"""Temporary localhost-only research API; never deploy as a product service."""
import asyncio
import sys
import threading
import time
sys.path.insert(0, '/app')
from fastapi import FastAPI, Request, HTTPException
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.chart_api import DataQuery, NativeHistory
from alerts import provider_cache as cache

url = make_url(settings.database_url)
assert url.host == 'pg' and url.database == 'chart_sync' and not settings.delivery_enabled
settings.provider_request_seconds = 300
cache.CAPACITY = 1002001
app = FastAPI()
events = []

@app.get('/events')
def history():
    return events

@app.post('/data')
async def data(raw: dict, request: Request):
    n = raw['countBack']
    if not isinstance(n, int) or not 1 <= n <= 1000000:
        raise HTTPException(422)
    # A fixed generous capacity would make even small requests scan a million
    # rows in the unchanged implementation. Serialize callers in experiments.
    cache.CAPACITY = int(n * 1.1) + 2001
    body = DataQuery.model_construct(instrument=raw.get('instrument', 'EURUSD'),
        series_kind='provider', timeframe=raw.get('timeframe', 'M5'), limit=n,
        count_back=n, before=raw['before'], from_time=raw.get('from'),
        first_data_request=False, client=None, indicators=raw.get('indicators', []),
        native_history=NativeHistory(chart_count=4, focused=True, historical_navigation=True),
        history_observation=None, native_reserve=None)
    cancelled = threading.Event()
    budget = min(300, raw.get('_budget_seconds', 300))
    deadline = time.monotonic() + budget
    ct = cache.CANCELLED.set(cancelled)
    dt = cache.DEADLINE.set(deadline)
    event = {'countBack': n, 'before': body.before, 'start': time.time()}
    events.append(event)
    task = asyncio.create_task(asyncio.to_thread(cache.data, body))
    def complete(done):
        event['worker_done'] = time.time()
        try:
            result = done.result()
            event['count'] = len(result['bars'])
        except BaseException as error:
            event['error'] = type(error).__name__
    task.add_done_callback(complete)
    try:
        while not task.done():
            if await request.is_disconnected():
                if 'disconnect' not in event:
                    event['disconnect'] = time.time()
                cancelled.set()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                event['timeout'] = time.time()
                raise HTTPException(503, 'research deadline exceeded')
            await asyncio.wait({task}, timeout=min(.05, remaining))
        return await task
    finally:
        cancelled.set()
        cache.CANCELLED.reset(ct)
        cache.DEADLINE.reset(dt)
