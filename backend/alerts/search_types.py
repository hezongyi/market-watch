"""Shared symbol-search types; series provenance is independent of asset type."""
TYPES = {"", "forex", "crypto", "index", "stock", "fund", "futures", "commodity", "other"}


def symbol_type(asset):
    return {"CURRENCY": "forex", "FOREX": "forex", "METAL": "commodity",
            "CRYPTO": "crypto", "INDEX": "index", "EQUITY": "stock", "STOCK": "stock",
            "ETF": "fund", "FUND": "fund", "FUTURE": "futures", "FUTURES": "futures",
            "metal": "commodity", "equity": "stock", "etf": "fund",
            "future": "futures"}.get(asset, asset if asset in TYPES and asset else "other")
