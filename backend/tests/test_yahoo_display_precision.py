"""Display precision follows the symbol while Yahoo observations retain precision."""

import pytest

from alerts.config import settings
from alerts import provider_yahoo as yahoo, yahoo_catalog
from alerts.storage import MarketCatalog


@pytest.mark.parametrize("kind,symbol,hint,price,expected", [
    ("EQUITY", "MSFT", 2, 530.82, 2),
    ("ETF", "SPY", 2, 650.25, 2),
    ("CURRENCY", "EURUSD=X", 5, 1.16431, 5),
    ("CURRENCY", "JPY=X", 3, 147.251, 3),
    ("FUTURE", "CL=F", 2, -37.63, 2),
    ("EQUITY", "LOW", 2, 0.001234, 5),
    ("EQUITY", "TINY", 2, 0.00000001, 8),
    ("EQUITY", "MSFT", None, 530.82, 2),
    ("CURRENCY", "EURUSD=X", None, None, 5),
    ("EQUITY", "MSFT", 99, 530.82, 2),
    ("EQUITY", "MSFT", True, 530.82, 2),
    ("EQUITY", "MSFT", -1, 530.82, 2),
    ("INDEX", "^GSPC", 0, 6400, 0),
])
def test_native_metadata_separates_display_precision_from_data(database, monkeypatch,
                                                             kind, symbol, hint, price, expected):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    details = yahoo._metadata({"symbol": symbol, "quoteType": kind, "exchange": "NMS",
                               "priceHint": hint, "regularMarketPrice": price})
    ident = yahoo_catalog._store(details)
    meta = yahoo_catalog.chart_metadata(ident, cached_only=True)
    assert meta["display_precision"] == expected
    assert meta["precision"] == 8
    with database.begin() as db:
        assert db.get(MarketCatalog, ident).precision == 8


@pytest.mark.parametrize("kind,expected", [("EQUITY", 2), ("CURRENCY", 5)])
def test_existing_metadata_without_hints_uses_type_default(database, monkeypatch, kind, expected):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    ident = yahoo_catalog._store({"symbol": "MSFT" if kind == "EQUITY" else "EURUSD=X",
                                 "english_name": "cached", "asset_type": kind,
                                 "adjustment": "auto", "updated_at": 1})
    meta = yahoo_catalog.chart_metadata(ident, cached_only=True)
    assert meta["display_precision"] == expected
    assert meta["precision"] == 8
