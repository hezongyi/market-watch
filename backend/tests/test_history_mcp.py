"""Browser and MCP consume identical fixed managed version snapshots."""

from alerts.history_retention import reclaim
from alerts.storage import MarketDemand
from sqlalchemy import func, select
from test_history_retention import prepared
from test_market_contracts import identity
from test_native_mcp import call, rpc
from test_native_mcp import mcp as mcp


def test_readonly_history_tools_match_browser_without_creating_demand(mcp):
    client, token, factory = mcp
    version, _ = prepared(factory)
    expected = {
        "history_get_dataset": ({"dataset_id": identity().key}, f"/api/market-data/center/datasets/{identity().key}"),
        "history_get_version": ({"version_id": version}, f"/api/market-data/versions/{version}"),
        "history_get_bars": ({"version_id": version, "count": 2}, f"/api/market-data/versions/{version}/chart?count=2"),
        "history_get_coverage": ({"version_id": version}, f"/api/market-data/versions/{version}/coverage"),
        "history_get_requests": ({"version_id": version}, f"/api/market-data/versions/{version}/requests"),
        "history_get_references": ({"dataset_id": identity().key}, f"/api/market-data/datasets/{identity().key}/references"),
        "history_list_tasks": ({"dataset_id": identity().key}, f"/api/market-data/center/tasks?dataset_id={identity().key}"),
        "history_list_datasets": ({"status": "archived"}, "/api/market-data/center/datasets?status=archived"),
    }
    listed = rpc(client, token, "tools/list").json()["result"]["tools"]
    for name, (arguments, path) in expected.items():
        tool = next(t for t in listed if t["name"] == name)
        assert tool["annotations"]["readOnlyHint"]
        result = call(client, token, name, arguments)
        assert not result["isError"]
        assert result["structuredContent"] == client.get(path).json()
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
        reclaim(db, identity().key, "clear")
    result = call(client, token, "history_get_bars", {"version_id": version})
    assert result["isError"] and result["structuredContent"]["error"]["code"] == "DATA_UNAVAILABLE"
    manifest = call(client, token, "history_get_version", {"version_id": version})["structuredContent"]
    assert manifest["payload_available"] is False


def test_fixed_history_tool_validation_does_not_download_or_create_dataset(mcp):
    client, token, factory = mcp
    result = call(client, token, "history_get_bars", {"version_id": "missing", "count": 5001})
    assert result["isError"]
    with factory.begin() as db:
        assert db.scalar(select(MarketDemand)) is None
