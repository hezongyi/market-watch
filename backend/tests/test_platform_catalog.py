"""Platform listing retains supported legacy identities without opening demand."""

from sqlalchemy import func, select

from alerts.config import settings
from alerts.platform_catalog import catalog
from alerts.storage import Instrument, MarketCatalog, MarketDemand, ProviderInterest


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
