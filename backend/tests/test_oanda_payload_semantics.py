"""Equivalent OANDA writer representations must preserve accepted price credentials."""

import pytest
from alerts import provider_chart as upstream
from alerts.display_snapshots import DisplaySnapshotError
from alerts.storage import ProviderDataset
from test_provider_cache import META, page, seed
from test_provider_display_snapshots import read
from test_provider_indicator_inputs import SPEC, stable_indicators


def test_equivalent_completed_flags_keep_snapshot(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    price = read()
    token = price['provider_snapshot_id']
    original = read(indicators=[SPEC], provider_snapshot_id=token)
    with database.begin() as db:
        epoch = db.get(ProviderDataset, key).metadata_json['indicator_history_epoch']
    incoming = page(998000, 1000000)
    for bar in incoming['bars']:
        bar.update(source_confirmed=True, coverage_complete=True)
    seed(META, 'M1', 1000000, incoming)
    result = read(indicators=[SPEC], provider_snapshot_id=token)
    assert result['bars'] == price['bars']
    assert stable_indicators(result) == stable_indicators(original)
    with database.begin() as db:
        assert db.get(ProviderDataset, key).metadata_json['indicator_history_epoch'] == epoch


def test_real_historical_correction_still_rejects_snapshot(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    seed(META, 'M1', 1000000, page(0, 1000000, boundary=True))
    token = read()['provider_snapshot_id']
    read(indicators=[SPEC], provider_snapshot_id=token)
    seed(META, 'M1', 1000000, page(998000, 999000, close='2.7'))
    with pytest.raises(DisplaySnapshotError, match='快照'):
        read(indicators=[SPEC], provider_snapshot_id=token)
