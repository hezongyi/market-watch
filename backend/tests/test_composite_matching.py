"""Verified draft rules, stable v2 identities and unchanged legacy references."""

import copy

import pytest
from alerts.composite_center import mapping_report
from alerts.composite_definitions import first_use, key, save_mapping
from alerts.composite_matching import MappingDraft, check_match
from alerts.config import settings
from alerts.storage import (CompositePreparation, CompositeRevision, MarketCatalog, MarketComposite,
    MarketDataset, MarketDemand, RealtimeMapping, RealtimeMappingNote)
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity
from test_market_datasets import register


def checked(db, catalog_id):
    result = check_match(db, identity().key, catalog_id)
    return result, MappingDraft.model_validate(result["suggestion"])


def test_notes_and_timestamp_refresh_reuse_runtime_identity(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        check, draft = checked(db, catalog)
        assert check["status"] == "ready" and not draft.reviewed
        assert draft.historical_evidence is None and draft.rationale == ""
        first = save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"])
        original = copy.deepcopy(first.match)
        assert save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"]).id == first.id
        assert db.scalar(select(func.count()).select_from(RealtimeMappingNote)) == 1
        db.get(MarketCatalog, catalog).updated_at += 100
        changed = draft.model_copy(update={"rationale": "简短备注"})
        repeated = save_mapping(db, identity().key, catalog, changed, snapshot=check["snapshot"])
        assert repeated.id == first.id and repeated.match == original
        assert mapping_report(db, repeated)["note"]["rationale"] == "简短备注"
        assert db.scalar(select(func.count()).select_from(RealtimeMapping)) == 1
        assert db.scalar(select(func.count()).select_from(RealtimeMappingNote)) == 2
        for table in (MarketDemand, MarketComposite, CompositePreparation):
            assert db.scalar(select(func.count()).select_from(table)) == 0


def test_v2_reuses_legacy_without_rehashing_or_mutating_references(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    publish(database)
    with database.begin() as db:
        legacy = save_mapping(db, identity().key, catalog, PROOF)
        expected = key({"dataset_id": identity().key, "permission_scope": "workspace:default",
            "target_dataset_id": legacy.target_dataset_id, "match": legacy.match})
        assert legacy.id == expected
        original = copy.deepcopy(legacy.match)
        composite = first_use(db, identity().key, legacy.id)
        revision = copy.deepcopy(db.get(CompositeRevision, composite.active_revision_id).__dict__)
        check, draft = checked(db, catalog)
        saved = save_mapping(db, identity().key, catalog,
            draft.model_copy(update={"rationale": "仅更新备注"}), snapshot=check["snapshot"])
        assert saved.id == legacy.id and saved.match == original
        assert first_use(db, identity().key, saved.id).id == composite.id
        fixed = db.get(CompositeRevision, composite.active_revision_id)
        assert fixed.mapping_id == legacy.id and fixed.seam == revision["seam"]
        assert fixed.history_version_id == revision["history_version_id"]
        assert db.scalar(select(func.count()).select_from(MarketComposite)) == 1


def test_multiple_legacy_configs_require_explicit_choice(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        first = save_mapping(db, identity().key, catalog, PROOF)
        second = save_mapping(db, identity().key, catalog, {**PROOF, "rationale": "Another explicit product review"})
        check, draft = checked(db, catalog)
        with pytest.raises(ValueError, match="多条"):
            save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"])
        assert save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"],
            reuse_mapping_id=first.id).id == first.id
        assert first.id != second.id


@pytest.mark.parametrize("field,value", [("underlying", "GBP"), ("quote_currency", "CAD"),
    ("historical_product", "other"), ("live_product", "cfd"),
    ("relationship", "same_underlying_different_product")])
def test_client_classifications_cannot_override_verified_identity(database, monkeypatch, field, value):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        check, draft = checked(db, catalog)
        draft = draft.model_copy(update={field: value, "reviewed": True})
        assert field in check_match(db, identity().key, catalog, draft)["errors"]
        with pytest.raises(ValueError, match="不一致"):
            save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"])
        assert db.scalar(select(RealtimeMapping)) is None


def test_key_catalog_changes_require_new_check_but_timestamps_do_not(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        check, draft = checked(db, catalog)
        db.get(MarketCatalog, catalog).precision = 4
        with pytest.raises(ValueError, match="关键属性"):
            save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"])
        db.get(MarketCatalog, catalog).available = False
        with pytest.raises(ValueError, match="当前OANDA"):
            check_match(db, identity().key, catalog)
    monkeypatch.setattr(settings, "oanda_account_id", "other-account")
    with database.begin() as db:
        with pytest.raises(ValueError, match="当前OANDA"):
            save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"])


def test_unknown_relation_cannot_be_approved_by_urls_or_checkbox(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        db.get(MarketCatalog, catalog).asset_type = "CFD"
        result = check_match(db, identity().key, catalog, {**MappingDraft().model_dump(),
            "historical_product": "cfd", "live_product": "cfd", "relationship": "same_product",
            "reviewed": True, "rationale": "已核对", "live_evidence": "https://example.test/"})
        assert result["status"] == "needs_information" and result["rule"] is None
        assert "relationship" in result["errors"]
        assert db.scalar(select(MarketDataset).where(MarketDataset.identity["source"].as_string() == "oanda")) is None


def test_existing_target_precision_conflict_is_blocked_before_save(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    with database.begin() as db:
        check, draft = checked(db, catalog)
        saved = save_mapping(db, identity().key, catalog, draft, snapshot=check["snapshot"])
        db.get(MarketCatalog, catalog).precision = 4
        changed = check_match(db, identity().key, catalog, draft)
        assert changed["status"] == "needs_information"
        assert "目录精度" in changed["errors"]["relationship"]
        with pytest.raises(ValueError, match="目录精度"):
            save_mapping(db, identity().key, catalog, draft, snapshot=changed["snapshot"])
        assert db.get(RealtimeMapping, saved.id) is saved


def test_gold_rule_records_cfd_and_metal_quote_without_asserting_legal_equivalence(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    gold = identity(provider_symbol="XAU/USD")
    with database.begin() as db:
        register(db, gold, logical_symbol="XAUUSD")
        entry = db.get(MarketCatalog, catalog)
        entry.symbol, entry.asset_type, entry.precision = "XAU_USD", "METAL", 3
        result = check_match(db, gold.key, catalog)
        assert result["suggestion"]["historical_product"] == "cfd"
        assert result["suggestion"]["live_product"] == "metal_quote"
        assert result["difference"] and any("gold" in item["url"] for item in result["sources"])
        draft = MappingDraft.model_validate(result["suggestion"])
        assert check_match(db, gold.key, catalog, draft)["errors"]["reviewed"]
        with pytest.raises(ValueError, match="黄金"):
            save_mapping(db, gold.key, catalog, draft, snapshot=result["snapshot"])
        saved = save_mapping(db, gold.key, catalog, draft.model_copy(update={"reviewed": True}),
            snapshot=result["snapshot"])
        assert saved.match["relationship"] == "same_underlying_different_product"
