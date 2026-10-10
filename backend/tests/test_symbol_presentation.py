"""Readable codes share one policy while supplier and dataset identities stay intact."""

import pytest

from alerts import market_data
from alerts.config import settings
from alerts.platform_catalog import catalog
from alerts.provider_chart import metadata
from alerts.storage import MarketCatalog


@pytest.mark.parametrize("source,code,kind,expected", [
    ("oanda", "EUR_USD", "CURRENCY", "EURUSD"),
    ("dukascopy", "eurusd", "CURRENCY", "EURUSD"),
    ("dukascopy", "EUR/USD", "CURRENCY", "EURUSD"),
    ("oanda", "XAU_USD", "METAL", "XAUUSD"),
    ("binance", "BTCUSDT", "CRYPTO", "BTCUSDT"),
    ("binance", "DOGEUSDC", "CRYPTO", "DOGEUSDC"),
    ("yahoo", "EURUSD=X", "CURRENCY", "EURUSD"),
    ("yahoo", "JPY=X", "CURRENCY", "USDJPY"),
    ("yahoo", "BTC-USD", "CRYPTOCURRENCY", "BTCUSD"),
    ("yahoo", "MSFT", "EQUITY", "MSFT"),
    ("yahoo", "^GSPC", "INDEX", "^GSPC"),
    ("yahoo", "CL=F", "FUTURE", "CL=F"),
    ("yahoo", "EURUSD", "EQUITY", "EURUSD"),
    ("oanda", "NAS100_USD", "INDEX", "NAS100USD"),
    ("dukascopy", "MSFT.US/USD", "OTHER", "MSFT.US/USD"),
    (None, "UNKNOWN", None, "UNKNOWN"),
])
def test_code_policy(source, code, kind, expected):
    from alerts.market_names import display_code

    assert display_code(code, source, kind) == expected


def test_platform_and_chart_search_share_display_and_preserve_ticker(database, monkeypatch):
    monkeypatch.setattr(settings, "yahoo_enabled", False)
    with database.begin() as db:
        db.add(MarketCatalog(id="OANDA:EUR_USD", source="oanda", symbol="EUR_USD",
            label="Euro vs US Dollar", asset_type="CURRENCY", precision=5, calendar="ny17", available=True))
        db.flush()
        for query in ("EUR/USD", "eurusd", "EUR_USD"):
            row = catalog(db, source="oanda", query=query)["items"][0]
            assert row["display_symbol"] == "EURUSD"
            assert row["provider_symbol"] == "EUR_USD"
    for query in ("EUR/USD", "eurusd", "EUR_USD"):
        rows = market_data.search_series(query, kind="provider", source="oanda")
        row = next(row for row in rows if row["id"] == "OANDA:EUR_USD")
        assert row["display_symbol"] == "EURUSD"
        assert row["symbol"] == "EUR_USD"
        assert row["ticker"] == "MWP:OANDA:EUR_USD"
    meta = metadata("OANDA:EUR_USD")
    assert meta["symbol"] == "EUR_USD" and meta["display_symbol"] == "EURUSD"


def test_slash_search_reaches_history_tasks_and_composite_without_first_use(database, monkeypatch):
    from test_series_access import fixture
    from alerts.data_center import dataset_list, task_list
    from alerts.series_access import search_page
    from alerts.storage import MarketComposite, MarketDemand
    from sqlalchemy import select
    from alerts.history_maintenance import configure
    from test_market_contracts import identity

    fixture(database, monkeypatch)
    with database.begin() as db:
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        for query in ("EUR/USD", "eurusd", "EUR_USD"):
            for kind in ("history", "composite"):
                row = search_page(db, query, kind=kind)["items"][0]
                assert row["display_symbol"] == "EURUSD" and row["symbol"] == "EURUSD"
            assert dataset_list(db, query=query)["items"][0]["display_symbol"] == "EURUSD"
            assert task_list(db, query=query)["items"][0]["dataset"]["display_symbol"] == "EURUSD"
        assert search_page(db, "_")["items"] == []
        assert search_page(db, "%")["items"] == []
        assert db.scalar(select(MarketComposite)) is None
        assert db.scalar(select(MarketDemand)) is None
