"""Category membership must be complete before SQL ranking/paging."""
import pytest
from alerts.dataset_summaries import summaries
from alerts.market_datasets import register_dataset
from alerts.storage import DatasetMaintenance, MarketCatalog
from test_market_contracts import identity


def seed_category(db, code, asset, source="dukascopy", exchange=None, kind=None):
    ident = identity(provider_symbol=code, source=source)
    register_dataset(db, ident, logical_symbol="".join(c for c in code if c.isalnum()), label=code,
        calendar="ny17", precision=5, volume_kind="quantity", volume_unit="source_quantity", asset_class=asset)
    db.add(DatasetMaintenance(dataset_id=ident.key, target_start=0, timeframes=["M1"], frequency="once", next_at=0))
    if exchange or kind:
        db.add(MarketCatalog(id="category-" + ident.key, source=source, symbol=code,
            label=code, asset_type=kind or "EQUITY", precision=2, available=True,
            metadata_json={"exchange": exchange} if exchange else {}))
    db.flush()
    return ident.key


def test_category_filters_all_members_before_ranking_and_facets_ignore_source(database):
    with database.begin() as db:
        # Metals precede FX alphabetically; FX must still have a full first page.
        for number in range(28):
            seed_category(db, f"A{number:03}", "metal")
            seed_category(db, f"Z{number:03}", "forex", "oanda" if number % 2 else "dukascopy")
        first = summaries(db, category="forex", include_categories=True, page_size=25)
        second = summaries(db, category="forex", page=2, page_size=25)
        assert first["total"] == second["total"] == 28
        assert len(first["items"]) == 25 and len(second["items"]) == 3
        assert all(row["asset_class"] == "forex" for row in first["items"] + second["items"])
        assert [row["position"] for row in second["items"]] == [26, 27, 28]
        assert not {r["id"] for r in first["items"]} & {r["id"] for r in second["items"]}
        assert first["categories"] == [{"value": "forex", "label": "外汇"}, {"value": "metal", "label": "贵金属"}]
        filtered = summaries(db, category="forex", source="oanda", include_categories=True)
        assert filtered["total"] == 14 and filtered["categories"] == first["categories"]
        assert summaries(db, category="forex", anchor="dataset-" + second["items"][0]["id"])["anchor_position"] == 26
        assert summaries(db, category="metal", ids=first["items"][0]["id"])["items"] == []
        with pytest.raises(ValueError, match="分类"):
            summaries(db, category="invalid")


def test_market_groups_match_row_badges_and_never_fold_etf_into_stocks(database):
    with database.begin() as db:
        a = [seed_category(db, code, "equity", "akshare") for code in ("SZSE:300750", "SSE:688256", "BSE:920001")]
        us = seed_category(db, "AAPL", "equity", "yahoo", "NMS")
        hk = seed_category(db, "0700.HK", "equity", "yahoo", "HKG")
        etf = seed_category(db, "SPY", "etf", "yahoo", "NMS", "ETF")
        fund = seed_category(db, "FUND", "etf", "yahoo", "NMS", "MUTUALFUND")
        unknown = seed_category(db, "UNKNOWN", "other")
        assert {r["id"] for r in summaries(db, category="a-stock")["items"]} == set(a)
        for group, expected in (("us-stock", us), ("hk-stock", hk), ("etf", etf), ("fund", fund), ("other", unknown)):
            assert [r["id"] for r in summaries(db, category=group)["items"]] == [expected]
        db.get(DatasetMaintenance, us).archived = True
        db.flush()
        active = summaries(db, include_categories=True)
        assert "us-stock" not in [c["value"] for c in active["categories"]]
        archived = summaries(db, category="us-stock", status="archived", include_categories=True)
        assert archived["total"] == 1 and archived["categories"] == [{"value": "us-stock", "label": "美股"}]


def test_api_category_contract_and_default_desktop_response_stay_compatible(database):
    from alerts import api
    from fastapi.testclient import TestClient
    with database.begin() as db:
        seed_category(db, "EUR/USD", "forex")
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            base = "/api/market-data/center/dataset-summaries"
            assert "categories" not in client.get(base).json()
            response = client.get(base + "?category=forex&include_categories=true&mobile=true")
            assert response.status_code == 200 and response.json()["total"] == 1
            assert response.json()["categories"] == [{"value": "forex", "label": "外汇"}]
            assert client.get(base + "?category=invalid").status_code == 422
    finally:
        api.app.dependency_overrides.clear()
