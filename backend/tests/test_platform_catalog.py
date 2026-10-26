"""Platform listing retains supported legacy identities without opening demand."""

from alerts.config import settings
from alerts.platform_catalog import catalog
from alerts.storage import Instrument, MarketCatalog, MarketDemand, ProviderInterest
from sqlalchemy import func, select


def test_platform_includes_legacy_binance_and_prefers_catalog_identity(database):
    with database.begin() as db:
        legacy = db.get(Instrument, "BTCUSDT")
        assert legacy and legacy.source == "binance"
        result = catalog(db, source="binance", query="BTC")
        assert result["total"] == 1
        assert result["items"][0]["id"] == legacy.id
        assert result["items"][0]["provider_symbol"] == legacy.symbol
        assert result["items"][0]["asset_class"] == "crypto"
        assert catalog(db, source="binance", query="missing")["total"] == 0
        assert catalog(db, source="binance", page=2, page_size=1)["items"] == []
        db.add(MarketCatalog(id="CAT:BTCUSDT", source="binance", symbol="BTCUSDT",
                             label="Catalog BTC", asset_type="CRYPTO", precision=3,
                             calendar="utc0", available=True))
        db.flush()
        result = catalog(db, source="binance")
        assert result["total"] == 1
        assert result["items"][0]["id"] == "CAT:BTCUSDT"
        assert result["items"][0]["precision"] == 3
        assert not db.new and not db.dirty
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
        assert db.scalar(select(func.count()).select_from(ProviderInterest)) == 0


def test_yahoo_directory_reflects_enablement_without_registering_or_fetching(database, monkeypatch):
    with database.begin() as db:
        db.add(MarketCatalog(id="YAHOO:test", source="yahoo", symbol="AAPL",
                             label="Apple", asset_type="EQUITY", precision=8,
                             calendar="yahoo", available=True, updated_at=0))
        db.flush()
        for enabled in (False, True):
            monkeypatch.setattr(settings, "yahoo_enabled", enabled)
            row = catalog(db, source="yahoo", query="Apple")["items"][0]
            assert row["available"] is enabled
            assert row["updated_at"] is None
            assert not db.new and not db.dirty
        assert db.scalar(select(func.count()).select_from(ProviderInterest)) == 0


def test_explicit_history_identity_is_never_listed_as_native_platform(database):
    from test_market_contracts import identity
    from test_market_datasets import register

    with database.begin() as db:
        dataset = register(db, identity(source="oanda", channel="v20", environment="practice",
                                       provider_symbol="EUR_USD", basis="bid"))
        rows = catalog(db, source="oanda")["items"]
        assert dataset.id not in {row["id"] for row in rows}


def test_platform_asset_filter_qualifies_before_paging(database, monkeypatch):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    with database.begin() as db:
        for index, asset in enumerate(("EQUITY", "ETF", "EQUITY", "INDEX")):
            db.add(MarketCatalog(id=f"YAHOO:asset{index}", source="yahoo", symbol=f"T{index}",
                label=f"Ticker{index}", asset_type=asset, precision=8, calendar="yahoo", available=True))
        db.flush()
        first = catalog(db, source="yahoo", asset="equity", page_size=1)
        second = catalog(db, source="yahoo", asset="equity", page_size=1, page=2)
        assert first["total"] == second["total"] == 2
        assert first["items"][0]["id"] != second["items"][0]["id"]
        assert catalog(db, source="yahoo", asset="etf")["items"][0]["asset_class"] == "etf"
        assert not db.new and not db.dirty
def test_search_asset_names_cover_provider_and_dataset_vocabularies():
    from alerts.search_types import symbol_type

    for names, expected in ((["EQUITY", "equity", "STOCK", "stock"], "stock"),
                            (["ETF", "etf", "FUND", "fund"], "fund"),
                            (["FUTURE", "future", "FUTURES", "futures"], "futures"),
                            (["METAL", "metal", "commodity"], "commodity")):
        assert all(symbol_type(name) == expected for name in names)
    assert symbol_type("unknown") == "other"


def test_dukascopy_stocks_are_found_with_category_query_and_source(database):
    from alerts.history_catalog import catalog as history_catalog

    with database() as db:
        for query, symbol in (("AAPL", "AAPL.US/USD"), ("0700.HK", "0700.HK/HKD"), ("7203.JP", "7203.JP/JPY")):
            rows = catalog(db, source="dukascopy", query=query, asset="equity")["items"]
            assert symbol in {row["provider_symbol"] for row in rows}
            assert not catalog(db, source="dukascopy", query=query, asset="future")["items"]
            historical = history_catalog(db, source="dukascopy", query=query, symbol_type="stock")["items"]
            assert symbol in {row["provider_symbol"] for row in historical}
        assert not db.new and not db.dirty


def test_symbol_search_includes_sina_and_tencent_from_platform_catalog(database, monkeypatch):
    from alerts.akshare_catalog import seed
    from alerts.market_data import search_series_page

    monkeypatch.setattr(settings, 'akshare_enabled', True)
    seed()
    for kind in ('provider', 'all'):
        page = search_series_page('000001', kind=kind, source='akshare', symbol_type='stock')
        rows = page['items']
        assert len(rows) == 2
        assert {r['provider_name'] for r in rows} == {'新浪 (AKShare)', '腾讯 (AKShare)'}
        assert any(r['ticker'] == 'MWP:TENCENT:SZSE:000001' for r in rows)
        assert all(r['type'] == 'stock' and r['available'] for r in rows)
        assert all(r['provider_name'] in r['description'] for r in rows)
    with database() as db:
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
        assert db.scalar(select(func.count()).select_from(ProviderInterest)) == 0
