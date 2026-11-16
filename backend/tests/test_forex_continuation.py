"""Ordinary FX admission, exact source boundaries and list/detail consistency."""

import os

import pytest
from alerts.composite_definitions import save_mapping
from alerts.composite_matching import MappingDraft, check_match, live_identity
from alerts.config import settings
from alerts.continuation_summaries import summaries
from alerts.history_artifacts import artifact_tick
from alerts.history_versions import create_version, import_page
from alerts.live_pricing import desired_datasets
from alerts.managed_continuation import configure, report
from alerts.storage import Instrument, MarketCatalog, MarketComposite, MarketDataset, MarketDemand
from sqlalchemy import select
from test_composite_definitions import prepare
from test_history_versions import Adapter
from test_market_contracts import batch, identity, minute
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg


@pytest.fixture(params=["sqlite", "postgres"])
def factory(request, monkeypatch):
    if request.param == "postgres":
        if not os.getenv("TEST_POSTGRES_URL"):
            pytest.skip("Requires isolated Ubuntu PostgreSQL")
        return request.getfixturevalue("provider_pg")[0]
    return request.getfixturevalue("database")


def setup(factory, monkeypatch, code="USD/JPY", *, source="dukascopy", live=None, kind="CURRENCY"):
    catalog_id = prepare(factory, monkeypatch)
    symbol = live or code.replace("/", "_")
    historical = identity(provider_symbol=code) if source == "dukascopy" else live_identity(symbol)
    precision = 3 if symbol.endswith("_JPY") else 5
    with factory.begin() as db:
        register(db, historical, logical_symbol=code.replace("/", ""), precision=precision)
        entry = db.get(MarketCatalog, catalog_id)
        entry.symbol, entry.asset_type, entry.precision = symbol, kind, precision
    return historical, catalog_id


@pytest.mark.parametrize("source", ["dukascopy", "oanda"])
@pytest.mark.parametrize("code", ["USD/JPY", "GBP/USD", "EUR/JPY", "AUD/CAD"])
def test_ordinary_fx_can_be_checked_and_saved_without_starting_collection(factory, monkeypatch, source, code):
    historical, catalog_id = setup(factory, monkeypatch, code, source=source)
    with factory.begin() as db:
        before = report(db, historical.key)
        assert before["supported"] and not before["enabled"]
        dataset = db.get(MarketDataset, historical.key)
        assert summaries(db, [dataset], {})[historical.key]["disabled_reason"] == "待配置"
        checked = check_match(db, historical.key, catalog_id)
        assert checked["status"] == "ready"
        assert checked["suggestion"]["underlying"] == code[:3]
        assert checked["suggestion"]["quote_currency"] == code[-3:]
        draft = MappingDraft.model_validate(checked["suggestion"])
        saved = save_mapping(db, historical.key, catalog_id, draft, snapshot=checked["snapshot"])
        assert save_mapping(db, historical.key, catalog_id, draft, snapshot=checked["snapshot"]).id == saved.id
        row = report(db, historical.key)
        assert row["mappings"][0]["valid_for_selection"]
        assert row["default_mapping_id"] == saved.id and not row["ready_to_enable"]
        assert summaries(db, [dataset], {})[historical.key]["disabled_reason"] == "待历史"
        target = db.get(MarketDataset, saved.target_dataset_id)
        assert db.get(Instrument, target.instrument_id).precision == (3 if code.endswith("JPY") else 5)
        assert db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(MarketComposite)) is None


@pytest.mark.parametrize("live,kind", [("JPY_USD", "CURRENCY"), ("EUR_JPY", "CURRENCY"),
    ("USD_JPY", "CFD"), ("USD_JPY", "METAL"), ("USDJPY", "CURRENCY")])
def test_fx_exact_pair_and_provider_type_cannot_be_overridden(factory, monkeypatch, live, kind):
    historical, catalog_id = setup(factory, monkeypatch, live=live, kind=kind)
    with factory.begin() as db:
        checked = check_match(db, historical.key, catalog_id)
        assert checked["status"] == "needs_information" and checked["rule"] is None
        assert not report(db, historical.key)["supported"]
        forged = MappingDraft(underlying="USD", quote_currency="JPY", historical_product="spot_fx",
            live_product="spot_fx", relationship="same_product", reviewed=True)
        with pytest.raises(ValueError):
            save_mapping(db, historical.key, catalog_id, forged, snapshot=checked["snapshot"])


@pytest.mark.parametrize("code", ["BTC/USD", "XAG/USD", "ABC/DEF"])
def test_non_forex_cannot_be_admitted_by_pair_shape_or_currency_label(factory, monkeypatch, code):
    historical, catalog_id = setup(factory, monkeypatch, code)
    with factory.begin() as db:
        checked = check_match(db, historical.key, catalog_id)
        assert checked["status"] == "needs_information"
        assert not report(db, historical.key)["supported"]
        dataset = db.get(MarketDataset, historical.key)
        assert summaries(db, [dataset], {})[historical.key]["disabled_reason"] == "规则未支持"


@pytest.mark.parametrize("source,changes", [
    ("dukascopy", {"channel": "other"}),
    ("dukascopy", {"environment": "practice"}),
    ("dukascopy", {"account_scope": "sha256:" + "0" * 64}),
    ("oanda", {"channel": "other"}),
    ("oanda", {"environment": "live"}),
    ("oanda", {"account_scope": "sha256:" + "0" * 64}),
])
def test_forex_requires_verified_historical_source_context(database, monkeypatch, source, changes):
    historical, catalog_id = setup(database, monkeypatch, source=source)
    historical = historical.model_copy(update=changes)
    with database.begin() as db:
        register(db, historical, logical_symbol="USDJPYALT", precision=3)
        assert check_match(db, historical.key, catalog_id)["status"] == "needs_information"
        assert not report(db, historical.key)["supported"]


@pytest.mark.parametrize("fault,label", [("credentials", "未配来源"), ("account", "目录无品种"),
    ("unavailable", "目录无品种"), ("type", "规则未支持"), ("basis", "不支持")])
def test_summary_and_detail_explain_ineligibility_before_mapping_exists(factory, monkeypatch, fault, label):
    historical, catalog_id = setup(factory, monkeypatch)
    if fault == "credentials":
        monkeypatch.setattr(settings, "oanda_token", "")
    with factory.begin() as db:
        entry = db.get(MarketCatalog, catalog_id)
        if fault == "account":
            entry.metadata_json = {"history_account_scope": "sha256:" + "0" * 64}
        elif fault == "unavailable":
            entry.available = False
        elif fault == "type":
            entry.asset_type = "CFD"
        elif fault == "basis":
            historical = identity(provider_symbol="USD/JPY", basis="ask")
            register(db, historical, logical_symbol="USDJPYASK", precision=3)
        db.flush()
        row = report(db, historical.key)
        assert not row["supported"] and row["reason"]
        summary = summaries(db, [db.get(MarketDataset, historical.key)], {})[historical.key]
        assert summary["disabled_reason"] == label and not summary["can_enable"]
        assert db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(MarketComposite)) is None


def test_usdjpy_published_history_enables_and_enters_worker_demand(factory, monkeypatch):
    historical, catalog_id = setup(factory, monkeypatch)
    end = 172920000
    with factory.begin() as db:
        version = create_version(db, historical.key, 0, end)
    import_page(Adapter([batch(identity=historical, window_end=end, checkpoint=end,
        rows=(minute(), minute(60000), minute(end - 120000), minute(end - 60000)))]), version_id=version)
    while artifact_tick(version):
        pass
    with factory.begin() as db:
        checked = check_match(db, historical.key, catalog_id)
        mapping = save_mapping(db, historical.key, catalog_id,
            MappingDraft.model_validate(checked["suggestion"]), snapshot=checked["snapshot"])
        enabled = configure(db, historical.key, value=True, mapping_id=mapping.id)
        assert enabled["enabled"] and enabled["ready_to_enable"]
        assert enabled["composite"]["revision"]["history_version_id"] == version
        revision = enabled["composite"]["active_revision_id"]
        assert configure(db, historical.key, value=True)["composite"]["active_revision_id"] == revision
    assert "USD_JPY" in desired_datasets(settings.oanda_account_id)
    with factory.begin() as db:
        disabled = configure(db, historical.key, value=False)
        assert not disabled["enabled"] and disabled["default_mapping_id"] == mapping.id
    assert "USD_JPY" not in desired_datasets(settings.oanda_account_id)
