"""FXCM registration and immutable maintenance on task-owned PostgreSQL."""

import os

import pytest
from alerts import fxcm_history
from alerts import history_versions as history
from alerts.aggregation_policy import register_history_dataset
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import configure, create_run
from alerts.history_sources import HistorySources, page_end
from alerts.market_contracts import DatasetIdentity
from alerts.storage import HistoryVersion
from test_fxcm_history import fxcm_config as _fxcm_config
from test_provider_fxcm import directory, native_cache_contract
from test_provider_postgres import provider_pg as _provider_pg

fxcm_config = _fxcm_config
provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires task-owned Ubuntu PostgreSQL")


def test_fxcm_managed_incremental_preserves_parent(provider_pg, fxcm_config, monkeypatch):
    factory, _ = provider_pg
    directory(factory, monkeypatch)
    with factory.begin() as db:
        dataset, _ = register_history_dataset(db, source="fxcm", logical_symbol="EURUSD",
            provider_symbol="EUR/USD", asset_class="forex", precision=5)
        identity = DatasetIdentity.model_validate(dataset.identity)
        assert dataset.volume_kind == "tick_count"
        assert identity.account_scope == fxcm_history.account_scope()
        assert page_end(identity, 0, 40000000) == 300 * 60000
        configure(db, dataset.id, target_start=0, timeframes=["M1", "H4"], overlap_minutes=1)
        parent = create_run(db, dataset.id, end=180000, request_id="initial").id
    calls = []
    revision = ["1.11000"]
    def bars(self, symbol, frame, start, end, digits, **kwargs):
        calls.append((start, end))
        return [{"start": at, "open": "1.10000", "high": "1.12000", "low": "1.09000",
                 "close": revision[0], "volume": "3"} for at in range(start, end, 60000)]
    monkeypatch.setattr(fxcm_history.FxcmHistory, "bars", bars)
    sources = HistorySources(adapters={"fxcm": fxcm_history.FxcmHistory(clock=lambda: 90000000)})
    while history.import_page(sources, version_id=parent):
        pass
    while artifact_tick(parent):
        pass
    with factory.begin() as db:
        state = db.get(HistoryVersion, parent)
        assert state.status == "published", (state.status, state.error)
        original = list(history.snapshot_rows(db, parent))
        manifest = db.get(HistoryVersion, parent).manifest
        assert len(original) == 3 and db.get(HistoryVersion, parent).status == "published"
        child = create_run(db, dataset.id, end=300000, request_id="incremental").id
    calls.clear()
    revision[0] = "1.10000"
    while history.import_page(sources, version_id=child):
        pass
    while artifact_tick(child):
        pass
    # SDK gets a bounded-capacity snapshot before the exclusive end; the
    # adapter clips it to the requested refresh window before persisting.
    assert calls == [(0, 299999)]
    with factory.begin() as db:
        assert list(history.snapshot_rows(db, parent)) == original
        assert db.get(HistoryVersion, parent).manifest == manifest
        current = list(history.snapshot_rows(db, child))
        assert [row["close"] for row in current] == ["1.11000"] * 2 + ["1.10000"] * 3
        assert db.get(HistoryVersion, child).status == "published"


def test_fxcm_cache_on_postgres(provider_pg, fxcm_config, monkeypatch):
    factory, _ = provider_pg
    native_cache_contract(factory, fxcm_config, monkeypatch)


def test_fxcm_shared_source_cache_preserves_tick_count(provider_pg, fxcm_config):
    from alerts.market_contracts import CandleBatch, MinuteRow, RequestResult
    from alerts.source_history_store import shared_page
    from alerts.storage import SourceFetch, now_ms
    from sqlalchemy import select
    from test_fxcm_history import fxcm_identity

    factory, _ = provider_pg
    identity = fxcm_identity()
    calls = []

    class Adapter:
        def page(self, ident, start, end):
            with factory.begin() as db:
                fetch = db.scalar(select(SourceFetch))
                assert fetch.lease_until - now_ms() > 65000
            calls.append((start, end))
            return CandleBatch(identity=ident, window_start=start, window_end=end,
                observed_at=now_ms(), checkpoint=end, volume_kind="tick_count",
                volume_unit="price_changes", result=RequestResult(status="data"),
                rows=(MinuteRow(timestamp=0, open="1.1", high="1.2", low="1.0",
                                close="1.1", volume="3", complete=True),))

    original = shared_page(Adapter(), identity, 0, 60000, fresh_after=0)
    evidence = {}
    cached = shared_page(Adapter(), identity, 0, 60000, fresh_after=0, evidence=evidence)
    assert calls == [(0, 60000)]
    assert evidence["read_kind"] == "shared_cache"
    assert cached == original
    assert (cached.volume_kind, cached.volume_unit) == ("tick_count", "price_changes")
