"""Local first snapshots and bounded, optional previous-session enrichment."""

import copy
import threading
import time
from collections import OrderedDict

from sqlalchemy import select

from .provider_cache import identity
from .provider_capabilities import fresh_seconds
from .storage import MarketStreamTask, ProviderBar, ProviderDataset, now_ms, transaction


def snapshot(meta):
    """Read the same identity's committed quote, without creating demand or IO."""
    key = identity(meta, 'M1')
    stamp = now_ms()
    with transaction() as db:
        task = db.execute(select(MarketStreamTask.payload, MarketStreamTask.updated_at).where(
            MarketStreamTask.identity['kind'].as_string() == 'quotes',
            MarketStreamTask.identity['series_kind'].as_string() == 'provider',
            MarketStreamTask.identity['dataset_id'].as_string() == key,
        ).order_by(MarketStreamTask.updated_at.desc()).limit(1)).first()
        if task and task.payload.get('type') == 'quotes' and task.payload.get('quotes'):
            row = copy.deepcopy(task.payload['quotes'][0])
            values = row['v']
            read_at = values.get('read_at') or task.updated_at
            if values.get('fetch_status') in (None, 'ok') and stamp - read_at > fresh_seconds(meta['source']) * 1000:
                values.update(fetch_status='stale', wait_reason='shared_refresh',
                              last_success_at=read_at, cache_age_ms=max(0, stamp-read_at))
            return row
        # A chart/account collector may have a candle before a quote task has
        # published. Yahoo must keep its quote contract, never substitute M1.
        dataset = db.get(ProviderDataset, key) if meta['source'] != 'yahoo' else None
        bar = db.scalar(select(ProviderBar.payload).where(ProviderBar.dataset_id == key,
            ProviderBar.start <= stamp).order_by(ProviderBar.start.desc()).limit(1)) if dataset else None
        if bar:
            fresh = stamp - dataset.latest_at <= fresh_seconds(meta['source']) * 1000
            values = dict(lp=float(bar['close']), quote_time=None, data_start=bar['start'],
                data_end=bar['end'], time_type='source_m1', resolution='M1',
                fetched_at=dataset.latest_at or None, read_at=dataset.latest_at or None,
                fetch_status='ok' if fresh else 'stale', last_success_at=dataset.latest_at or None,
                cache_age_ms=max(0, stamp-dataset.latest_at))
            if meta['basis'] in ('bid', 'ask'):
                values[meta['basis']] = values['lp']
            return {'s':'ok', 'v':values}
    return {'s':'ok', 'v':{'fetch_status':'pending', 'wait_reason':'first_quote',
                           'quote_time':None, 'data_start':None, 'read_at':None}}


class PreviousCloses:
    """At most two background reads, one per source; no queued supplier work.

    The current native daily boundary and full dataset identity fence reuse.
    A missing/slow prior close never occupies the live calculation threads.
    """
    def __init__(self, executor=None):
        self.executor = executor
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def read(self, meta, latest):
        from .provider_chart import label, previous_close_query, quote_previous_close
        before, _, _ = previous_close_query(meta, latest)
        session = label(latest['start'], 'D1', meta['calendar']) if meta['source'] == 'fxcm' else before
        key = (identity(meta, 'D1'), session)
        now = time.monotonic()
        with self.lock:
            # Harvest completed futures without waiting. Keep failed/empty
            # references bounded too, so list rebuilds cannot trigger retries.
            for entry in self.entries.values():
                future = entry.get('future')
                if future is not None and future.done():
                    entry.pop('future')
                    try:
                        entry['value'] = future.result()
                        entry['until'] = now + 300
                    except Exception:
                        entry['value'], entry['until'] = None, now + 30
            entry = self.entries.get(key)
            if entry and entry.get('until', 0) > now:
                self.entries.move_to_end(key)
                return entry.get('value')
            busy = [e for e in self.entries.values() if e.get('future') is not None]
            if self.executor is not None and len(busy) < 2 and not any(e['source'] == meta['source'] for e in busy):
                entry = {'source':meta['source'], 'future':self.executor.submit(quote_previous_close,
                    copy.deepcopy(meta), copy.deepcopy(latest))}
                self.entries[key] = entry
                self.entries.move_to_end(key)
            while len(self.entries) > 128:
                removable = next((k for k, e in self.entries.items() if e.get('future') is None), None)
                if removable is None:
                    break
                del self.entries[removable]
            return None


def page(meta):
    """One latest native candle, persisted/shared with charts and collectors."""
    from . import provider_cache as cache
    from .market_notices import error_evidence
    from .provider_capabilities import request_seconds
    from .provider_chart import quote_page

    frame = 'D1' if meta['source'] == 'akshare' else 'M1'
    before = now_ms() // 15000 * 15000 + 1
    key = cache.ensure(meta, frame)
    # Preserve the account collector's exclusive latest ownership. Its waiting
    # path is cache-only and already carries truthful pending/stale evidence.
    if meta['source'] == 'oanda' and cache.rest_batch_owner_active(key):
        return quote_page(meta)
    try:
        result = cache.fetch_page(key, meta, frame, before, 1,
            time.monotonic() + max(23, request_seconds(meta['source'])),
            kind='history', latest=True)
    except Exception as error:
        cached = cache.snapshot(key, before, 1)
        if not cached['bars']:
            raise
        return {**cached, 'fetch_status':'fetch_failed', 'read_at':now_ms(),
                'error_evidence':error_evidence(error,provider=meta['source'],operation='quote_page')}
    return {**result, 'fetch_status':'ok', 'read_at':now_ms()}
