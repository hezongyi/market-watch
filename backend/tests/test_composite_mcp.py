"""Read-only composite MCP/browser parity and no demand side effects."""

from alerts.composite_definitions import first_use, save_mapping
from alerts.storage import MarketDemand
from sqlalchemy import select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity
from test_native_mcp import call, rpc
from test_native_mcp import mcp as mcp


def test_composite_mcp_matches_browser_and_never_creates_live_demand(mcp, monkeypatch):
    client, token, factory = mcp
    catalog = prepare(factory, monkeypatch)
    publish(factory)
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: 165725000)
    monkeypatch.setattr("alerts.composite_quotes.now_ms", lambda: 165725000)
    with factory.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        ident = composite.id
    expected = {
        "composite_list": ({}, "/center/composites"),
        "composite_list_candidates": ({}, "/center/composite-candidates"),
        "composite_get_mappings": ({"dataset_id": identity().key}, f"/datasets/{identity().key}/mappings"),
        "composite_get": ({"composite_id": ident}, f"/composites/{ident}"),
        "composite_get_quote": ({"composite_id": ident}, f"/composites/{ident}/quote"),
        "composite_get_requests": ({"composite_id": ident}, f"/composites/{ident}/requests"),
        "composite_get_bars": ({"composite_id": ident, "before": 165600000, "count": 2},
                               f"/composites/{ident}/chart?before=165600000&count=2"),
    }
    tools = rpc(client, token, "tools/list").json()["result"]["tools"]
    for name, (args, path) in expected.items():
        assert next(tool for tool in tools if tool["name"] == name)["annotations"]["readOnlyHint"]
        result = call(client, token, name, args)
        assert not result["isError"], result
        assert result["structuredContent"] == client.get("/api/market-data" + path).json()
    invalid = call(client, token, "composite_get_bars", {"composite_id": ident, "count": 2001})
    assert invalid["isError"]
    for dataset_id, expected_count in ((identity().key, 1), ("0" * 64, 0)):
        args = {"dataset_id": dataset_id}
        listed = call(client, token, "composite_list", args)["structuredContent"]
        assert listed == client.get("/api/market-data/center/composites", params=args).json()
        assert listed["total"] == expected_count
    with factory.begin() as db:
        assert db.scalar(select(MarketDemand)) is None
