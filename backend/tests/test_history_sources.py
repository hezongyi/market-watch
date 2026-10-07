"""OANDA managed history shares contracts with Dukascopy but keeps its identity."""

import hashlib

import httpx
import pytest
from alerts import history_versions as history
from alerts.aggregation_policy import change_aggregation, register_history_dataset
from alerts.config import settings
from alerts.history_sources import HistorySources
from alerts.oanda_stream import OandaPractice
from alerts.storage import DatasetSource, HistoryVersion, SourceSeries
from sqlalchemy import func, select
from test_market_contracts import batch, minute
from test_market_datasets import register
from test_source_registry import oanda


def test_oanda_large_history_is_bounded_before_adapter_and_published(database):
    identity = oanda()
    stop = 4001 * 60000
    with database.begin() as db:
        register(db, identity)
        ident = history.create_version(db, identity.key, 0, stop)

    class Adapter:
        def __init__(self):
            self.calls = []

        def page(self, raw, start, end):
            assert raw == identity and end - start <= 4000 * 60000
            self.calls.append((start, end))
            return batch(identity=raw, window_start=start, window_end=end,
                observed_at=stop + 5000, checkpoint=end, rows=(minute(start, volume="3"),),
                volume_kind="price_count", volume_unit="quotes")

    adapter = Adapter()
    sources = HistorySources(adapters={"oanda": adapter})
    assert history.import_page(sources, version_id=ident)
    assert history.import_page(sources, version_id=ident)
    assert adapter.calls == [(0, 4000 * 60000), (4000 * 60000, stop)]
    with database.begin() as db:
        report = history.version_report(db, ident)
        assert report["status"] == "published"
        assert report["manifest"]["identity"] == identity.model_dump()
        assert report["manifest"]["volume_kind"] == "price_count"
        assert [row["timestamp"] for row in history.snapshot_rows(db, ident)] == [0, 4000 * 60000]


def test_rest_confirmed_oanda_m1_is_original_snapshot_and_rephases_without_fetch(database):
    account = "history-fixture"
    identity = oanda().model_copy(update={"account_scope": "sha256:" + hashlib.sha256(account.encode()).hexdigest()})
    calls = []

    def response(request):
        calls.append(request)
        assert request.url.params["granularity"] == "M1"
        assert request.url.params["price"] == "B" and request.url.params["smooth"] == "false"
        return httpx.Response(200, json={"instrument": "EUR_USD", "granularity": "M1", "candles": [
            {"time": "0", "complete": True, "volume": 3,
             "bid": {"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.11"}},
            {"time": "60", "complete": False, "volume": 1,
             "bid": {"o": "1.10", "h": "1.12", "l": "1.09", "c": "1.11"}},
        ]})

    with database.begin() as db:
        register(db, identity)
        parent = history.create_version(db, identity.key, 0, 120000)
    with httpx.Client(transport=httpx.MockTransport(response)) as client:
        adapter = OandaPractice(token="fixture", account_id=account, rest_client=client,
                                stream_client=client, clock=lambda: 125000)
        history.import_page(HistorySources(adapters={"oanda": adapter}), version_id=parent)
    with database.begin() as db:
        original = list(history.snapshot_rows(db, parent))
        assert len(original) == 1 and original[0]["volume"] == "3"
        target, _, derived = change_aggregation(db, identity.key, "utc0", version_id=parent)
        assert db.get(DatasetSource, target.id).source_id == db.get(DatasetSource, identity.key).source_id
        derived_id = derived.id
    while history.import_page(HistorySources(), version_id=derived_id):
        pass
    with database.begin() as db:
        assert list(history.snapshot_rows(db, derived_id)) == original
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1
        assert db.get(HistoryVersion, parent).status == "published"
    assert len(calls) == 1


def test_missing_oanda_credentials_stop_as_configuration_error(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_token", "")
    monkeypatch.setattr(settings, "oanda_account_id", "")
    with database.begin() as db:
        register(db, oanda())
        ident = history.create_version(db, oanda().key, 0, 120000)
    assert history.import_page(HistorySources(), version_id=ident)
    with database.begin() as db:
        report = history.version_report(db, ident)
        assert report["status"] == "configuration_error"
        assert report["cursor"] == 0 and report["error"] == "history_source_configuration"
    assert not history.import_page(HistorySources(), version_id=ident)


def test_register_oanda_account_scope_is_server_selected(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_token", "fixture-token")
    monkeypatch.setattr(settings, "oanda_account_id", "fixture-account")
    with database.begin() as db:
        dataset, inst = register_history_dataset(db, source="oanda", logical_symbol="EURUSD",
            provider_symbol="EUR_USD", asset_class="forex", precision=5)
        assert inst.calendar == "ny17" and dataset.volume_kind == "price_count"
        assert dataset.identity["account_scope"] == "sha256:" + hashlib.sha256(b"fixture-account").hexdigest()
        assert dataset.identity["channel"] == "v20"
        with pytest.raises(ValueError, match="准确"):
            register_history_dataset(db, source="oanda", logical_symbol="EURUSD",
                provider_symbol="EUR/USD", asset_class="forex", precision=5)
