"""Price credentials pin mutable provider tails across API/worker processes."""

import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.chart_api import DataQuery
from alerts.display_snapshots import DisplaySnapshotError
from test_provider_cache import META, page, seed
from test_provider_indicator_inputs import SPEC


def read(**kwargs):
    return cache.data(DataQuery(instrument=META['id'], series_kind='provider',
                               timeframe='M1', before=1000000, limit=200, **kwargs))


def test_price_snapshot_restores_original_forming_tail(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    seed(META, 'M1', 1000000, page(999000, 1000000, complete=False, close='1.2'))
    price = read()
    original = read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])
    seed(META, 'M1', 1001000, page(999000, 1001000, close='2.8'))
    # A new minute and a revised forming close must not alter old accepted prices.
    old = read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])
    assert old['bars'] == price['bars']
    assert old['indicators'] == original['indicators']
    assert old['cache_revision'] == price['cache_revision']
    assert old['provider_snapshot_id'] == price['provider_snapshot_id']
    assert read()['bars'] != old['bars']


def test_snapshot_rejects_earlier_correction_and_other_dataset(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    price = read()
    seed(META, 'M1', 1000000, page(300000, 301000, close='2.7'))
    with pytest.raises(DisplaySnapshotError, match='快照'):
        read(indicators=[SPEC], provider_snapshot_id=price['provider_snapshot_id'])


def test_snapshot_expiry_and_capacity_are_bounded(database, monkeypatch):
    from alerts import provider_display_snapshots as snapshots
    from alerts.storage import Preference
    from sqlalchemy import func, select

    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(snapshots, 'MAX_SNAPSHOTS', 3)
    seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    first = read()['provider_snapshot_id']
    for i in range(5):
        seed(META, 'M1', 1000000, page(999000, 1000000, close=str(1 + i / 10)))
        read()
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(Preference).where(
            Preference.key.startswith(snapshots.PREFIX))) == 3
    with pytest.raises(DisplaySnapshotError):
        read(indicators=[SPEC], provider_snapshot_id=first)


@pytest.mark.parametrize('frame', ['D1', 'W1', 'MN'])
@pytest.mark.parametrize('spec', [{'name': 'EMA', 'params': {'period': 2}}, {'name': 'SWING_SR_V1'}])
def test_snapshot_accepts_future_display_label_for_admitted_source_candle(database, monkeypatch, frame, spec):
    from alerts import provider_display_snapshots as snapshots
    payload = page(1000, 15000)
    for bar in payload['bars']:
        bar['chart_time'] = bar['start'] + 20000
    key = seed(META, frame, 35000, payload)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(cache, 'now_ms', lambda: 10000)
    monkeypatch.setattr(snapshots, 'now_ms', lambda: 10000)
    with cache.snapshot_transaction(key, 35000, 200, source_before=10001) as (db, price):
        price['dataset_id'] = key
        snapshots.capture(db, price, full_series=False)
    snapshots.publish(price)
    result = cache.data(DataQuery(instrument=META['id'], series_kind='provider', timeframe=frame,
        before=30001, limit=200, indicators=[spec], provider_snapshot_id=price['provider_snapshot_id']))
    assert result['bars'] == price['bars']
    assert result['bars'][-1]['start'] == 10000
    assert result['bars'][-1]['chart_time'] == 30000
    assert all(series['values'][-1]['time'] == 10000 for series in result['indicators'][0]['series'])
    if spec['name'] == 'SWING_SR_V1':
        assert result['indicators'][0]['presentation']['as_of_bar_time'] == 10000
