"""Equivalent OANDA writers preserve credentials; actual input changes still fence them."""

import copy
import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts import provider_display_snapshots as snapshots
from alerts import provider_indicator_inputs as inputs
from alerts.display_snapshots import DisplaySnapshotError
from alerts.storage import Preference, ProviderBar, ProviderDataset
from sqlalchemy import event, select
from test_provider_cache import META, page, seed
from test_provider_display_snapshots import read
from test_provider_indicator_inputs import SPEC, stable_indicators
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg


@pytest.fixture(params=['sqlite', 'postgres'])
def store(request):
    if request.param == 'postgres':
        if not os.getenv('TEST_POSTGRES_URL'):
            pytest.skip('Requires task-owned PostgreSQL')
        return request.getfixturevalue('provider_pg')[0]
    return request.getfixturevalue('database')


def bar_state(store, key, start=998000):
    with store.begin() as db:
        bar = db.get(ProviderBar, (key, start))
        dataset = db.get(ProviderDataset, key)
        return (dataset.metadata_json['indicator_history_epoch'], bar.revision,
                bar.changed_at, bar.price_confirmed_at, copy.deepcopy(bar.payload),
                bar.observed_at, dataset.revision)


def legacy_payload(store, key, flags):
    # Bypass the new commit boundary: model already persisted old-writer data.
    with store.begin() as db:
        for bar in db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key)):
            payload = dict(bar.payload)
            for field in ('source_confirmed', 'coverage_complete'):
                payload.pop(field, None)
            payload.update(flags)
            bar.payload = payload


@pytest.mark.parametrize('old_flags,new_flags', [
    ({}, {'source_confirmed': True, 'coverage_complete': True}),
    ({'source_confirmed': True, 'coverage_complete': True}, {}),
    ({'source_confirmed': True}, {'coverage_complete': True}),
])
@pytest.mark.parametrize('old_price,new_price', [('2.000', '2'), ('2', '2.000')])
def test_equivalent_completed_flags_keep_snapshot(store, monkeypatch, old_flags, new_flags,
                                                 old_price, new_price):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    legacy_payload(store, key, old_flags)
    with store.begin() as db:
        for bar in db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key)):
            bar.payload = {**bar.payload, 'close': old_price}
    price = read()
    token = price['provider_snapshot_id']
    original = read(indicators=[SPEC], provider_snapshot_id=token)
    before = bar_state(store, key)
    incoming = page(998000, 1000000)
    incoming['coverage'] = [[998000, 1000000]]
    for bar in incoming['bars']:
        bar.update(new_flags)
        bar['close'] = new_price
    untouched = copy.deepcopy(incoming)
    progress = {'advanced': False}
    context = cache.PAGE_PROGRESS.set(progress)
    try:
        for _ in range(2):
            assert cache.commit_rest_latest(key, incoming, before[5] + 10) == []
            assert not progress['advanced'], 'equivalent payload is not pagination progress'
            result = read(indicators=[SPEC], provider_snapshot_id=token)
            assert result['bars'] == price['bars']
            assert stable_indicators(result) == stable_indicators(original)
            assert result['indicators'][0]['calculation']['coverage'] == original['indicators'][0]['calculation']['coverage']
            assert bar_state(store, key)[:5] == before[:5]
        assert incoming == untouched
        after = bar_state(store, key)
        assert after[5] == before[5] + 10
        assert after[6] == before[6] + 2, 'dataset commit revisions still advance'
        inputs._INPUTS.clear()
        inputs._RESULTS.clear()
        assert stable_indicators(read(indicators=[SPEC], provider_snapshot_id=token)) == stable_indicators(original)
    finally:
        cache.PAGE_PROGRESS.reset(context)


@pytest.mark.parametrize('change', [
    {'close': '2.7'}, {'open': '1.1'}, {'high': '3.1'}, {'low': '-0.1'},
    {'volume': '9', 'volume_complete': True}, {'volume_complete': False},
    {'source_confirmed': False}, {'coverage_complete': False},
    {'gap_before': True}, {'chart_time': 998001}, {'end': 999001}, {'complete': False},
])
def test_real_historical_change_still_rejects_snapshot(store, monkeypatch, change):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    initial = page(0, 1000000, boundary=True)
    for bar in initial['bars']:
        bar.update(volume='7', volume_complete=True)
    key = seed(META, 'M1', 1000000, initial)
    token = read()['provider_snapshot_id']
    read(indicators=[SPEC], provider_snapshot_id=token)
    before = bar_state(store, key)
    payload = {'bars': [{**initial['bars'][-2], **change}], 'history_boundary': False,
               'revalidation': True}
    seed(META, 'M1', 1000000, payload)
    assert bar_state(store, key)[0] != before[0]
    with pytest.raises(DisplaySnapshotError, match='快照'):
        read(indicators=[SPEC], provider_snapshot_id=token)
    fresh = read()
    recovered = read(indicators=[SPEC], provider_snapshot_id=fresh['provider_snapshot_id'])
    inputs._INPUTS.clear()
    inputs._RESULTS.clear()
    assert stable_indicators(read(indicators=[SPEC], provider_snapshot_id=fresh['provider_snapshot_id'])) == stable_indicators(recovered)


@pytest.mark.parametrize('operation', ['insert', 'delete'])
def test_historical_insert_and_revalidation_delete_rotate_epoch(store, monkeypatch, operation):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    initial = page(0, 1000000, boundary=True)
    if operation == 'insert':
        initial['bars'] = [bar for bar in initial['bars'] if bar['start'] != 998000]
    key = seed(META, 'M1', 1000000, initial)
    token = read()['provider_snapshot_id']
    read(indicators=[SPEC], provider_snapshot_id=token)
    payload = page(998000, 999000) if operation == 'insert' else {
        'bars': [], 'history_boundary': False, 'revalidation': True,
        'coverage': [[998000, 999000]]}
    seed(META, 'M1', 999000, payload)
    with pytest.raises(DisplaySnapshotError):
        read(indicators=[SPEC], provider_snapshot_id=token)
    assert key


@pytest.mark.parametrize('source,complete', [('oanda', False), ('binance', True), ('yahoo', True)])
def test_unproven_defaults_are_not_equated(store, source, complete):
    meta = {**META, 'source': source, 'adjustment': 'unadjusted'}
    payload = page(998000, 1000000, complete=complete)
    key = seed(meta, 'M1', 1000000, payload)
    before = bar_state(store, key)
    for bar in payload['bars']:
        bar.update(source_confirmed=complete, coverage_complete=complete)
    seed(meta, 'M1', 1000000, payload)
    assert bar_state(store, key)[0] != before[0]


@pytest.mark.parametrize('reason', ['missing', 'ttl', 'epoch', 'calendar', 'legacy', 'identity'])
def test_rejection_reason_is_internal_and_redacted(store, monkeypatch, caplog, reason):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    token = read()['provider_snapshot_id']
    with store.begin() as db:
        record = db.get(Preference, snapshots.PREFIX + token)
        dataset = db.get(ProviderDataset, key)
        if reason == 'missing':
            db.delete(record)
        elif reason == 'ttl':
            record.value = {**record.value, 'expires': 0}
        elif reason == 'epoch':
            dataset.metadata_json = {**dataset.metadata_json, 'indicator_history_epoch': 'changed'}
        elif reason == 'calendar':
            dataset.metadata_json = {**dataset.metadata_json, 'calendar': 'changed'}
        elif reason == 'identity':
            record.value = {**record.value, 'content': {**record.value['content'], 'dataset': 'another'}}
        else:
            dataset.metadata_json = {k: v for k, v in dataset.metadata_json.items() if k != 'indicator_history_epoch'}
            dataset.revision += 1
            record.value = {**record.value, 'content': {**record.value['content'], 'epoch': None}}
    with caplog.at_level(logging.INFO, logger=snapshots.__name__):
        with pytest.raises(DisplaySnapshotError) as error:
            read(indicators=[SPEC], provider_snapshot_id=token)
    assert error.value.code == 'DISPLAY_SNAPSHOT_EXPIRED'
    entry = json.loads(caplog.records[-1].message.split(' ', 1)[1])
    assert entry['reason'] == reason
    assert len(entry['attempt_ref']) == 32
    assert token not in caplog.text and META['id'] not in caplog.text


@pytest.mark.parametrize('correction', [False, True])
def test_repeatable_read_during_concurrent_writer(provider_pg, monkeypatch, correction):
    store, engine = provider_pg
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    legacy_payload(store, key, {})
    price = read()
    original = read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])
    selected, committed = threading.Event(), threading.Event()
    reader_ident = []

    def pause_reader(conn, cursor, statement, params, context, many):
        if (threading.get_ident() in reader_ident and not selected.is_set()
                and statement.lstrip().upper().startswith('SELECT')
                and 'provider_datasets' in statement):
            selected.set()
            assert committed.wait(5)

    def reader():
        reader_ident.append(threading.get_ident())
        return read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])

    event.listen(engine, 'after_cursor_execute', pause_reader)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(reader)
            try:
                assert selected.wait(5)
                incoming = page(998000, 1000000, close='2.7' if correction else '2.000')
                incoming['coverage'] = [[998000, 1000000]]
                for bar in incoming['bars']:
                    bar.update(source_confirmed=True, coverage_complete=True)
                cache.commit_rest_latest(key, incoming, cache.now_ms())
            finally:
                committed.set()
            result = pending.result(timeout=5)
        assert result['bars'] == price['bars']
        assert stable_indicators(result) == stable_indicators(original)
        if correction:
            with pytest.raises(DisplaySnapshotError):
                read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])
        else:
            assert stable_indicators(read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])) == stable_indicators(original)
    finally:
        committed.set()
        event.remove(engine, 'after_cursor_execute', pause_reader)


def test_concurrent_writer_lease_and_retry_preserve_equivalent_snapshot(provider_pg, monkeypatch):
    store, _ = provider_pg
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    legacy_payload(store, key, {})
    price = read()
    before = bar_state(store, key)
    lease = cache.claim(key)
    attempted = threading.Event()

    def batch_writer():
        try:
            cache.commit_rest_latest(key, page(998000, 1000000), cache.now_ms())
        finally:
            attempted.set()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(batch_writer)
        try:
            assert attempted.wait(5)
            with pytest.raises(TimeoutError, match='租约'):
                pending.result(timeout=5)
            assert cache.commit_page(key, lease, page(998000, 1000000), 1000000,
                                     cache.now_ms()) == []
        finally:
            cache.release(key, lease)
    incoming = page(998000, 1000000)
    incoming['coverage'] = [[998000, 1000000]]
    for bar in incoming['bars']:
        bar.update(source_confirmed=True, coverage_complete=True)
    assert cache.commit_rest_latest(key, incoming, cache.now_ms()) == []
    assert bar_state(store, key)[:5] == before[:5]
    assert read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])['bars'] == price['bars']
