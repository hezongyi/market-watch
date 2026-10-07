"""Unified business selection is the same pure browser/MCP operation."""

from alerts.storage import MarketComposite, MarketDemand
from sqlalchemy import select
from test_native_mcp import call
from test_native_mcp import mcp as mcp
from test_series_access import fixture


def test_search_mcp_and_browser_share_qualified_candidates_without_creation(mcp, monkeypatch):
    client, token, factory = mcp
    parent = fixture(factory, monkeypatch)
    for kind in ("history", "composite", "all"):
        result = call(client, token, "series_search", {"query": "EURUSD", "kind": kind})
        assert not result["isError"]
        assert result["structuredContent"]["items"] == client.get(
            "/api/market-data/series/search", params={"query": "EURUSD", "kind": kind}).json()
    fixed = call(client, token, "series_search", {"query": "EURUSD", "kind": "history"})
    assert fixed["structuredContent"]["items"][0]["ticker"] == "MWH:" + parent
    with factory.begin() as db:
        assert db.scalar(select(MarketComposite)) is None and db.scalar(select(MarketDemand)) is None


def test_paginated_mcp_and_browser_match_with_filters(mcp, monkeypatch):
    client, token, factory = mcp
    from test_series_search_pagination import large_catalog

    large_catalog(factory, count=55)
    args = {"kind": "history", "page_size": 10, "offset": 15, "source": "dukascopy", "calendar": "utc0"}
    result = call(client, token, "series_search", args)
    assert not result["isError"]
    assert result["structuredContent"] == client.get("/api/market-data/series/page", params=args).json()
    assert result["structuredContent"]["items"]
