"""Protocol, cross-adapter consistency and permission regression checks."""

import json
import time
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from alerts import api, storage
from alerts.capabilities.actions import build_registry
from alerts.capabilities.context import CallContext
from alerts.capabilities.models import Empty, StatusResult
from alerts.capabilities.registry import Capability, Registry
from alerts.mcp.auth import digest, issue, revoke
from fastapi.testclient import TestClient
from indicator_assertions import stable_indicators
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

SCOPES = ["market:read", "analysis:read", "alerts:read", "charts:read", "alerts:write"]


@pytest.fixture
def mcp(database, monkeypatch, tmp_path):
    # Separate connections exercise real atomic commit/rollback under concurrent retries.
    engine = create_engine(
        "sqlite:///" + str(tmp_path / "agent.sqlite"),
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    storage.bootstrap(engine)
    database = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", database)
    monkeypatch.setattr(api.settings, "mcp_enabled", True)
    monkeypatch.setattr(api.settings, "mcp_calls_per_minute", 600)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    token = issue("acceptance-agent", SCOPES, storage.now_ms() + 600000)
    with TestClient(api.app, base_url="http://127.0.0.1:8000") as client:
        yield client, token, database
    engine.dispose()
    api.app.dependency_overrides.clear()
    api.app.router.routes[:] = [
        r for r in api.app.router.routes if getattr(r, "name", "") != "native_mcp"
    ]


def rpc(client, token, method, params=None, path="/mcp", extra_headers=None):
    headers = {
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    headers.update(extra_headers or {})
    return client.post(
        path,
        headers=headers,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
    )


def call(client, token, name, arguments=None):
    response = rpc(client, token, "tools/call", {"name": name, "arguments": arguments or {}})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def seed_bars(database):
    start = int(datetime(2026, 9, 21, tzinfo=UTC).timestamp() * 1000)
    with database.begin() as db:
        for i in range(80):
            value = Decimal("1.10") + Decimal(i) / 10000
            for frame, width in [("H1", 3600000), ("M1", 60000)]:
                db.add(
                    storage.Bar(
                        instrument_id="EURUSD",
                        timeframe=frame,
                        start=start + i * width,
                        end=start + (i + 1) * width,
                        open=value,
                        high=value + Decimal(".001"),
                        low=value - Decimal(".001"),
                        close=value,
                        complete=True,
                    )
                )
    return start


def test_initialize_discovery_and_call(mcp):
    client, token, _ = mcp
    response = rpc(
        client,
        token,
        "initialize",
        {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "native-mcp-test", "version": "1"},
        },
    )
    assert response.status_code == 200
    assert response.json()["result"]["serverInfo"]["name"] == "Market Watch"
    tools = rpc(client, token, "tools/list").json()["result"]["tools"]
    assert len(tools) == 34
    assert any(tool["name"] == "composite_get_quote" for tool in tools)
    assert any(tool["name"] == "history_get_creation" for tool in tools)
    assert all(
        t["inputSchema"]["type"] == "object" and t["outputSchema"]["type"] == "object"
        for t in tools
    )
    result = call(client, token, "market_list_instruments")
    assert not result.get("isError")
    assert len(result["structuredContent"]["items"]) == 3
    assert rpc(client, token, "tools/list", path="/mcp/").status_code == 200


def test_supertrend_enum_inputs_and_sparse_outputs_match_shared_chart_api(mcp):
    client, token, database = mcp
    seed_bars(database)
    query = {"instrument": "EURUSD", "timeframe": "H1", "limit": 20,
             "indicators": [{"name": "SUPERTREND_PINE_V1", "params": {
                 "period": 3, "source": "ohlc4", "atr_method": "sma", "multiplier": 0.5}}]}
    result = call(client, token, "indicators_calculate", query)
    assert not result.get("isError"), result
    browser = client.post("/api/charts/data", json=query | {"provisional": False}).json()
    assert result["structuredContent"]["page"]["indicators"] == browser["indicators"]
    query["indicators"][0]["params"]["source"] = "arbitrary-code"
    assert call(client, token, "indicators_calculate", query)["isError"]


def test_authentication_scopes_expiry_revoke(mcp):
    client, token, database = mcp
    assert rpc(client, None, "tools/list").status_code == 401
    assert rpc(client, "invalid", "tools/list").status_code == 401
    read = issue("read-agent", ["market:read"], storage.now_ms() + 600000)
    names = [t["name"] for t in rpc(client, read, "tools/list").json()["result"]["tools"]]
    assert "chart_alerts_create" not in names and "indicators_calculate" not in names
    result = call(client, read, "chart_alerts_create", {"idempotency_key": "blocked", "config": {}})
    assert result["isError"] and result["structuredContent"]["error"]["code"] == "FORBIDDEN"
    with database.begin() as db:
        db.get(storage.AgentCredential, digest(read)).expires_at = storage.now_ms() - 1
    assert rpc(client, read, "tools/list").status_code == 401
    revoke(digest(token))
    assert rpc(client, token, "tools/list").status_code == 401


def test_quote_bars_indicator_match_browser(mcp):
    client, token, database = mcp
    seed_bars(database)
    web_price = next(r for r in client.get("/api/instruments").json() if r["id"] == "EURUSD")
    quote = call(client, token, "market_get_quote", {"instrument": "EURUSD"})["structuredContent"]
    assert quote["price"] == web_price["price"]
    assert (
        quote["price_type"] == web_price["price_type"] and quote["quality"] == web_price["quality"]
    )
    params = {
        "instrument": "EURUSD",
        "timeframe": "H1",
        "limit": 20,
        "indicators": [{"name": "EMA", "params": {"period": 10}}, {"name": "RSI"}],
    }
    web = client.post("/api/charts/data", json={**params, "track_history": True}).json()
    result = call(client, token, "indicators_calculate", params)
    assert not result.get("isError"), result
    page = result["structuredContent"]["page"]
    assert page["bars"] == web["bars"]
    assert page["indicators"] == web["indicators"]
    assert page["history_revision"] == web["history_revision"]
    assert result["structuredContent"]["next_before"] == web["bars"][0]["start"]
    with database.begin() as db:
        bar = db.scalar(
            select(storage.Bar).where(storage.Bar.timeframe == "H1").order_by(storage.Bar.start)
        )
        bar.close += Decimal(".0001")
        bar.revision += 1
    changed = call(client, token, "indicators_calculate", params)["structuredContent"]["page"]
    assert changed["history_revision"] != page["history_revision"]
    assert changed["indicators"] != page["indicators"]


def test_unavailable_limits_and_insufficient_history(mcp):
    client, token, database = mcp
    result = call(client, token, "market_get_bars", {"instrument": "EURUSD"})
    assert result["isError"] and result["structuredContent"]["error"]["code"] == "DATA_UNAVAILABLE"
    result = call(client, token, "market_get_bars", {"instrument": "EURUSD", "limit": 2001})
    assert result["isError"] and result["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    seed_bars(database)
    result = call(
        client,
        token,
        "indicators_calculate",
        {"instrument": "EURUSD", "indicators": [{"name": "SMA", "params": {"period": 100}}]},
    )
    assert (
        result["isError"] and result["structuredContent"]["error"]["code"] == "INSUFFICIENT_HISTORY"
    )




def test_saved_drawings_identity_unknown_and_old_document(mcp):
    client, token, database = mcp
    projected = {
        "version": 1,
        "charts": [
            {
                "chart_id": "0",
                "symbol": "MWP:EURUSD",
                "resolution": "60",
                "drawings": [
                    {
                        "id": "trend",
                        "name": "trend_line",
                        "points": [{"time": 10, "price": 1.1}, {"time": 20, "price": 1.2}],
                    },
                    {"id": "unknown", "name": "unsupported", "points": [{"time": 1, "price": 2}]},
                ],
            }
        ],
    }
    with database.begin() as db:
        row = storage.AdvancedWorkspace(
            name="native", document={"state": {"_mwDrawingProjection": projected}}
        )
        old = storage.AdvancedWorkspace(name="old", document={"state": {"charts": []}})
        db.add_all([row, old])
        db.flush()
        ident, old_id = row.id, old.id
    result = call(client, token, "charts_get_drawings", {"workspace_id": ident})[
        "structuredContent"
    ]
    chart = result["charts"][0]
    assert chart["instrument"] == "EURUSD" and chart["series_kind"] == "provider"
    assert chart["timeframe"] == "H1"
    assert chart["drawings"][0]["anchors"] == [
        {"time": 10000, "price": "1.1"},
        {"time": 20000, "price": "1.2"},
    ]
    assert not chart["drawings"][1]["supported"] and chart["drawings"][1]["anchors"] == []
    assert result["revision"] == 1 and result["visibility"] == "saved_only"
    # Unsaved client edits do not change persisted data.
    projected["charts"][0]["drawings"][0]["points"][0]["price"] = 99
    assert (
        call(client, token, "charts_get_drawings", {"workspace_id": ident})["structuredContent"]
        == result
    )
    assert (
        call(client, token, "charts_get_drawings", {"workspace_id": old_id})["structuredContent"][
            "error"
        ]["code"]
        == "UNSUPPORTED_CAPABILITY"
    )
    assert (
        call(client, token, "charts_get_drawings", {"workspace_id": "missing"})[
            "structuredContent"
        ]["error"]["code"]
        == "WORKSPACE_NOT_FOUND"
    )


def test_registration_schema_and_automatic_protocol_exposure(mcp, monkeypatch):
    client, token, _ = mcp
    registry = Registry()
    cap = Capability(
        "test_new_action",
        "Registration test",
        Empty,
        StatusResult,
        frozenset({"market:read"}),
        "read",
        lambda ctx, q: {
            "mcp_enabled": True,
            "queried_at": 1,
            "active_alerts": 0,
            "recent_signals": 0,
            "delivery_enabled": False,
            "tools": [],
        },
    )
    registry.register(cap)
    with pytest.raises(ValueError, match="duplicate"):
        registry.register(cap)
    from alerts.mcp.adapter import Adapter

    adapter = Adapter(registry.freeze())
    ctx = CallContext(
        "acceptance-agent", digest(token), frozenset(SCOPES), "test-request", time.monotonic() + 20
    )
    assert adapter.tools(ctx)[0].name == "test_new_action"
    import asyncio

    async def run():
        result = await adapter.call(ctx, "test_new_action", {})
        await adapter.close()
        return result

    assert not asyncio.run(run()).is_error
    with pytest.raises(ValueError, match="frozen"):
        registry.register(cap)
    assert len(build_registry().visible(frozenset(SCOPES))) == 34


def test_host_origin_body_quota_and_disable(mcp, monkeypatch):
    client, token, _ = mcp
    assert (
        rpc(client, token, "tools/list", extra_headers={"Host": "evil.example"}).status_code == 421
    )
    assert (
        rpc(
            client, token, "tools/list", extra_headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert rpc(client, token, "tools/list", {"padding": "x" * 70000}).status_code == 413
    monkeypatch.setattr(api.settings, "mcp_calls_per_minute", 1)
    fresh = issue("quota", ["market:read"], storage.now_ms() + 600000)
    assert rpc(client, fresh, "tools/list").status_code == 200
    assert rpc(client, fresh, "tools/list").status_code == 429


def test_disabled_and_restart_lifecycle(database, monkeypatch):
    counts = {"start": 0, "stop": 0}
    from alerts import provider_service

    monkeypatch.setattr(
        provider_service, "start", lambda: counts.__setitem__("start", counts["start"] + 1)
    )
    monkeypatch.setattr(
        provider_service, "stop", lambda: counts.__setitem__("stop", counts["stop"] + 1)
    )
    monkeypatch.setattr(api.settings, "mcp_enabled", False)
    with TestClient(api.app) as client:
        assert client.post("/mcp").status_code == 404
    monkeypatch.setattr(api.settings, "mcp_enabled", True)
    for _ in range(2):
        with TestClient(api.app, base_url="http://127.0.0.1:8000") as client:
            token = issue("lifecycle", ["market:read"], storage.now_ms() + 600000)
            assert rpc(client, token, "tools/list").status_code == 200
            assert sum(getattr(r, "name", "") == "native_mcp" for r in api.app.router.routes) == 2
    assert counts == {"start": 3, "stop": 3}
    api.app.router.routes[:] = [
        r for r in api.app.router.routes if getattr(r, "name", "") != "native_mcp"
    ]


def test_new_registration_discovered_over_protocol(database, monkeypatch):
    from alerts.mcp import server

    registry = Registry()
    registry.register(
        Capability(
            "test_new_action",
            "Registration protocol check",
            Empty,
            StatusResult,
            frozenset({"market:read"}),
            "read",
            lambda ctx, q: {
                "mcp_enabled": True,
                "queried_at": 1,
                "active_alerts": 0,
                "recent_signals": 0,
                "delivery_enabled": False,
                "tools": [],
            },
        )
    )
    monkeypatch.setattr(server, "build_registry", lambda: registry.freeze())
    monkeypatch.setattr(api.settings, "mcp_enabled", True)
    token = issue("new-module-agent", ["market:read"], storage.now_ms() + 600000)
    with TestClient(api.app, base_url="http://127.0.0.1:8000") as client:
        tools = rpc(client, token, "tools/list").json()["result"]["tools"]
        assert [t["name"] for t in tools] == ["test_new_action"]
        assert call(client, token, "test_new_action")["structuredContent"]["queried_at"] == 1
    api.app.router.routes[:] = [
        r for r in api.app.router.routes if getattr(r, "name", "") != "native_mcp"
    ]


def test_indicator_registration_discovered_and_calculated(mcp, monkeypatch):
    from alerts import chart_indicators as indicators

    monkeypatch.setattr(indicators, "CATALOG", dict(indicators.CATALOG))
    monkeypatch.setattr(indicators, "CALCULATORS", dict(indicators.CALCULATORS))
    indicators.register(
        "MCP_TEST_CLOSE",
        {
            "label": "Test close",
            "pane": "main",
            "params": {},
            "parameter_schema": {},
            "series": [{"key": "value", "type": "line"}],
            "history_requirement": lambda params: 0,
        },
        lambda h, low, c, params: {"value": c},
    )
    with pytest.raises(ValueError, match="already registered"):
        indicators.register(
            "MCP_TEST_CLOSE",
            {
                "label": "Test close",
                "pane": "main",
                "params": {},
                "parameter_schema": {},
                "series": [{"key": "value", "type": "line"}],
            },
            lambda *args: {},
        )
    client, token, database = mcp
    seed_bars(database)
    assert (
        "MCP_TEST_CLOSE"
        in call(client, token, "indicators_list")["structuredContent"]["indicators"]
    )
    result = call(
        client,
        token,
        "indicators_calculate",
        {
            "instrument": "EURUSD",
            "timeframe": "H1",
            "limit": 1,
            "indicators": [{"name": "MCP_TEST_CLOSE"}],
        },
    )
    page = result["structuredContent"]["page"]
    assert page["indicators"][0]["series"][0]["values"][0]["value"] == float(
        page["bars"][0]["close"]
    )


def test_provider_data_contract_and_shared_query(mcp, monkeypatch):
    from alerts import provider_chart
    from alerts.chart_query import DataQuery, data_sync

    client, token, _ = mcp
    monkeypatch.setattr(
        provider_chart,
        "metadata",
        lambda name, **kwargs: {
            "source": "binance",
            "calendar": "utc0",
            "basis": "last",
            "precision": 2,
        },
    )
    page = {
        "bars": [
            {
                "start": 60000,
                "end": 120000,
                "chart_time": 60000,
                "open": "1",
                "high": "2",
                "low": "1",
                "close": "2",
                "complete": True,
            }
        ],
        "indicators": [],
        "has_more": False,
        "as_of": 120000,
        "cache_revision": 3,
        "coverage": [[0, 120000]],
        "history_boundary": True,
        "basis": "last",
        "calendar": "utc0",
        "precision": 2,
    }
    monkeypatch.setattr(provider_chart, "data", lambda body: page)
    result = call(
        client,
        token,
        "market_get_bars",
        {"instrument": "BTCUSDT", "series_kind": "provider", "timeframe": "M1"},
    )
    assert not result.get("isError"), result
    assert (
        result["structuredContent"]["page"]["bars"]
        == data_sync(DataQuery(instrument="BTCUSDT", series_kind="provider", timeframe="M1"))[
            "bars"
        ]
    )
    assert result["structuredContent"]["page"]["cache_revision"] == 3
    assert result["structuredContent"]["page"]["coverage"] == [[0, 120000]]


def test_deadline_and_disconnect_set_cancellation(database, monkeypatch):
    import asyncio
    import threading

    from alerts import chart_query as chart_api
    from alerts.provider_cache import CANCELLED

    stopped = threading.Event()

    def slow(body):
        cancellation = CANCELLED.get()
        cancellation.wait(2)
        stopped.set()
        return {}

    monkeypatch.setattr(chart_api, "data_sync", slow)

    async def run():
        with pytest.raises(Exception) as caught:
            await chart_api.query_chart(
                chart_api.DataQuery(instrument="BTCUSDT", timeframe="M1"),
                deadline=time.monotonic() + 0.01,
                retain_work=True,
            )
        assert caught.value.status_code == 503
        assert stopped.is_set()
        stopped.clear()

        async def disconnected():
            return True

        with pytest.raises(asyncio.CancelledError):
            await chart_api.query_chart(
                chart_api.DataQuery(instrument="BTCUSDT", timeframe="M1"),
                disconnected=disconnected,
                retain_work=True,
            )
        assert stopped.is_set()

    asyncio.run(run())


def test_official_sdk_client_transport(database, monkeypatch):
    import asyncio

    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    monkeypatch.setattr(api.settings, "mcp_enabled", True)
    token = issue("sdk-client", ["market:read"], storage.now_ms() + 600000)

    async def run():
        async with api.lifespan(api.app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=api.app),
                headers={"Authorization": "Bearer " + token},
            ) as http:
                async with streamable_http_client(
                    "http://127.0.0.1:8000/mcp", http_client=http
                ) as streams:
                    async with ClientSession(streams[0], streams[1]) as session:
                        initialized = await session.initialize()
                        assert initialized.server_info.name == "Market Watch"
                        tools = await session.list_tools()
                        assert "market_list_instruments" in [item.name for item in tools.tools]
                        result = await session.call_tool("market_list_instruments", {})
                        assert not result.is_error
                        assert result.structured_content["items"]

    asyncio.run(run())
    api.app.router.routes[:] = [
        r for r in api.app.router.routes if getattr(r, "name", "") != "native_mcp"
    ]


def test_notification_ack_and_signals_share_browser_rules(mcp):
    client, token, database = mcp
    from legacy_records import archived_watch
    with database.begin() as db:
        record = archived_watch(db, "EURUSD", "Acknowledgement history", {"kind": "price", "level": "1.2"})
        watch = {"id": record.id}
        signal = storage.SignalRow(
            watch_id=watch["id"],
            instrument_id="EURUSD",
            occurred_at=storage.now_ms(),
            direction="buy",
            price=Decimal("1.2"),
            threshold=Decimal("1.2"),
            reason="synthetic ack fixture",
            evidence={},
        )
        db.add(signal)
        db.flush()
        notification = storage.Notification(signal_id=signal.id)
        db.add(notification)
        db.flush()
        ident = notification.id
        db.add(storage.Outbox(notification_id=ident))
    listed = call(client, token, "alerts_get_signals", {"watch_id": watch["id"]})[
        "structuredContent"
    ]["items"]
    browser = client.get("/api/signals").json()
    assert listed == [r for r in browser if r["watch_id"] == watch["id"]]
    args = {"idempotency_key": "ack-once", "notification_id": ident}
    first = call(client, token, "notifications_ack", args)
    assert first["structuredContent"] == {"id": ident, "status": "acknowledged"}
    assert (
        call(client, token, "notifications_ack", args)["structuredContent"]
        == first["structuredContent"]
    )
    with database.begin() as db:
        assert (
            db.scalar(select(storage.Outbox).where(storage.Outbox.notification_id == ident)).status
            == "cancelled"
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(storage.Audit)
                .where(storage.Audit.kind == "acknowledged")
            )
            == 1
        )


def test_real_native_projection_document(mcp):
    from pathlib import Path

    client, token, database = mcp
    file = (
        Path(__file__).resolve().parents[2]
        / "docs/verification/native-mcp/real-native-drawing-projection.json"
    )
    document = json.loads(file.read_text())
    with database.begin() as db:
        row = storage.AdvancedWorkspace(name="real-native-generated", document=document)
        db.add(row)
        db.flush()
        ident = row.id
    result = call(client, token, "charts_get_drawings", {"workspace_id": ident})[
        "structuredContent"
    ]
    chart = result["charts"][0]
    assert chart["instrument"] == "BTCUSDT" and chart["series_kind"] == "provider"
    assert {r["object_type"] for r in chart["drawings"]} == {
        "horizontal_line",
        "trend_line",
        "rectangle",
    }
    assert all(r["supported"] for r in chart["drawings"])
    assert chart["time_coordinate"] == "native_chart_time_ms"
    expected = document["state"]["_mwDrawingProjection"]["charts"][0]["drawings"]
    assert [r["object_id"] for r in chart["drawings"]] == [r["id"] for r in expected]
    assert [r["anchors"] for r in chart["drawings"]] == [
        [{"time": p["time"] * 1000, "price": str(p["price"])} for p in r["points"]]
        for r in expected
    ]


def test_yahoo_session_breaks_do_not_claim_missing_trading_bars(mcp, monkeypatch):
    from alerts import provider_chart

    client, token, _ = mcp
    monkeypatch.setattr(
        provider_chart,
        "metadata",
        lambda *a, **k: {
            "source": "yahoo",
            "calendar": "yahoo",
            "basis": "adjusted",
            "precision": 8,
        },
    )
    rows = [
        {
            "start": start,
            "end": start + 3600000,
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100",
            "complete": True,
        }
        for start in (3600000, 86400000)
    ]
    monkeypatch.setattr(
        provider_chart,
        "data",
        lambda body: {
            "bars": rows,
            "indicators": [],
            "has_more": False,
            "as_of": 90000000,
            "cache_revision": 1,
            "basis": "adjusted",
            "calendar": "yahoo",
        },
    )
    result = call(
        client,
        token,
        "market_get_bars",
        {"instrument": "YAHOO:" + "a" * 32, "series_kind": "provider", "timeframe": "H1"},
    )
    assert not result.get("isError"), result
    data = result["structuredContent"]
    assert data["gap_assessment"] == "unknown_calendar"
    assert data["gaps"] == []
    assert data["interval_breaks"] == [{"start": 7200000, "end": 86400000}]
    assert data["quality"] == "calendar_unverified"


def test_published_indicator_budget_counts_published_snapshot(mcp, monkeypatch):
    from alerts.capabilities import actions

    client, token, _ = mcp
    queried_tables = []

    class Counter:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def scalar(self, query):
            queried_tables.extend(str(table) for table in query.get_final_froms())
            return 200001

    # Only intercept the capability history guard, not auth or audit transactions.
    monkeypatch.setattr(actions, "transaction", Counter)
    result = call(
        client,
        token,
        "indicators_calculate",
        {"instrument": "EURUSD", "published": True, "indicators": [{"name": "EMA"}]},
    )
    assert result["isError"]
    assert result["structuredContent"]["error"]["code"] == "RESOURCE_LIMIT"
    assert queried_tables == ["chart_published_bars"]


def test_native_daily_pagination_uses_chart_labels(mcp, monkeypatch):
    from alerts import provider_chart

    client, token, _ = mcp
    monkeypatch.setattr(
        provider_chart,
        "metadata",
        lambda *a, **k: {"source": "oanda", "calendar": "ny17", "basis": "bid", "precision": 5},
    )
    label = 1791244800000
    row = {
        "start": label - 3 * 3600000,
        "end": label + 21 * 3600000,
        "chart_time": label,
        "open": "1.1",
        "high": "1.2",
        "low": "1",
        "close": "1.1",
        "complete": True,
    }
    monkeypatch.setattr(
        provider_chart,
        "data",
        lambda body: {
            "bars": [row],
            "indicators": [],
            "has_more": True,
            "as_of": label + 86400000,
            "cache_revision": 1,
            "basis": "bid",
            "calendar": "ny17",
        },
    )
    result = call(
        client,
        token,
        "market_get_bars",
        {"instrument": "EURUSD", "series_kind": "provider", "timeframe": "D1"},
    )
    assert not result.get("isError"), result
    assert result["structuredContent"]["next_before"] == label
    assert result["structuredContent"]["cursor_coordinate"] == "native_chart_time_ms"


def test_bars_revision_changes_when_deletion_offsets_revision_increment(mcp):
    client, token, database = mcp
    seed_bars(database)
    query = {"instrument": "EURUSD", "timeframe": "H1", "limit": 20}
    original = call(client, token, "market_get_bars", query)["structuredContent"]["page"]
    with database.begin() as db:
        rows = list(db.scalars(
            select(storage.Bar).where(storage.Bar.timeframe == "H1").order_by(storage.Bar.start)
        ))
        # The revision sum is unchanged: one row removed, another incremented.
        db.delete(rows[2])
        rows[-1].close += Decimal(".0001")
        rows[-1].revision += 1
    updated = call(client, token, "market_get_bars", query)["structuredContent"]["page"]
    assert original["history_revision"] != updated["history_revision"]
    web = client.post("/api/charts/data", json={**query, "track_history": True}).json()
    assert updated["history_revision"] == web["history_revision"]


def test_chart_alert_events_share_mcp_browser_signals_and_independent_ack(mcp):
    from alerts.chart_alert_service import consume, create
    from test_chart_alert_service import config, sample

    client, token, database = mcp
    with database.begin() as db:
        alert = create(db, 'combined-chart-rule', config(), at=0)
        consume(db, alert.id, sample(0, 9), detected_at=0)
        first = consume(db, alert.id, sample(1, 11), detected_at=300_000)
        consume(db, alert.id, sample(2, 9), detected_at=600_000)
        second = consume(db, alert.id, sample(3, 11), detected_at=900_000)
        alert_id, event_ids = alert.id, {first.id, second.id}
    result = call(client, token, 'alerts_get_signals', {})
    assert not result.get('isError'), result
    listed = result['structuredContent']['items']
    browser = client.get('/api/signals').json()
    assert listed == browser
    assert {r['id'] for r in listed} == event_ids
    assert all(r['watch_id'] is None and r['chart_alert_id'] == alert_id for r in listed)
    note_id = listed[0]['notification_id']
    acknowledged = call(client, token, 'notifications_ack', {
        'idempotency_key': 'combined-ack-one', 'notification_id': note_id,
    })
    assert not acknowledged.get('isError'), acknowledged
    updated = client.get('/api/signals').json()
    assert sum(r['notification_status'] == 'acknowledged' for r in updated) == 1
    with database() as db:
        assert db.get(storage.ChartAlert, alert_id).count == 2
    # Legacy creation/cancellation remains its original one-shot watch contract.
    assert client.get('/api/watches').status_code == 410


def test_mcp_provisional_indicator_is_explicit_and_matches_browser_when_opted_in(mcp):
    client, token, database = mcp
    start = seed_bars(database)
    with database.begin() as db:
        last = db.scalar(select(storage.Bar).where(storage.Bar.timeframe == 'H1').order_by(storage.Bar.start.desc()))
        last.complete = False
        last.close = last.high = Decimal('99')
    query = {'instrument':'EURUSD','timeframe':'H1','limit':3,
             'indicators':[{'name':'SMA','params':{'period':3}}]}
    default = call(client,token,'indicators_calculate',query)
    assert not default.get('isError'),default
    assert default['structuredContent']['page']['indicators'][0]['series'][0]['values'][-1]['value'] is None
    opted = call(client,token,'indicators_calculate',{**query,'provisional':True})
    assert not opted.get('isError'),opted
    page = opted['structuredContent']['page']
    point = page['indicators'][0]['series'][0]['values'][-1]
    assert point['value'] is not None and point['provisional'] is True
    web = client.post('/api/charts/data',json=query).json()
    assert page['indicators'] == web['indicators']
    assert page['bars'] == web['bars']
    assert page['origin'] == start


def test_mcp_provider_fixed_origin_matches_browser_after_earlier_backfill(mcp, monkeypatch):
    from alerts import provider_cache, provider_chart
    from alerts.chart_query import DataQuery
    from alerts.storage import ProviderBar

    client, token, database = mcp
    meta = {'id':'BTCUSDT','source':'binance','symbol':'BTCUSDT','basis':'last',
            'calendar':'utc0','precision':2,'calendar_profile':{}}
    monkeypatch.setattr(provider_chart,'metadata',lambda *args,**kwargs:meta)
    key = provider_cache.ensure(meta,'M1')
    history = [{'start':i*60000,'end':(i+1)*60000,'open':str(10+i),'high':str(10+i),
                'low':str(10+i),'close':str(10+i),'complete':True} for i in range(40)]
    def read(*args,**kwargs):
        return {'dataset_id':key,'bars':history[-10:],'has_more':True,'basis':'last',
                'calendar':'utc0','precision':2,'as_of':2400000}
    monkeypatch.setattr(provider_cache,'read',read)
    with database.begin() as db:
        for row in history:
            db.add(ProviderBar(dataset_id=key,start=row['start'],chart_time=row['start'],
                               complete=True,payload=row,observed_at=2400000))
    query={'instrument':'BTCUSDT','series_kind':'provider','timeframe':'M1','before':2400000,
           'limit':5,'calculation_origin':600000,'indicators':[{'name':'EMA','params':{'period':3}}]}
    from alerts.chart_query import data_sync
    web = data_sync(DataQuery(**query))
    result=call(client,token,'indicators_calculate',query)
    assert not result.get('isError'),result
    page=result['structuredContent']['page']
    assert page['calculation_origin']==600000
    assert stable_indicators(page)==stable_indicators(web)
    assert page['bars']==web['bars']


def test_provider_calculation_evidence_and_quality_survive_output_model(mcp, monkeypatch):
    from alerts import provider_chart

    client, token, _ = mcp
    meta = {'source': 'binance', 'basis': 'last', 'calendar': 'utc0'}
    monkeypatch.setattr(provider_chart, 'metadata', lambda *args, **kwargs: meta)
    page = {'bars': [{'start': 60000, 'end': 120000, 'open': '1', 'high': '1', 'low': '1',
                     'close': '1', 'complete': True}], 'has_more': False, 'basis': 'last',
            'calendar': 'utc0', 'as_of': 180000, 'provider_snapshot_id': 'a' * 64,
            'cache_revision': 7, 'calculation_origin': 0,
            'indicators': [{'name': 'EMA', 'version': '1', 'params': {'period': 2},
                'series': [{'key': 'value', 'type': 'line', 'values': [
                    {'time': 60000, 'value': 1.0, 'break_before': True, 'provisional': True}]}],
                'calculation': {'status': 'complete', 'visible_complete': True, 'algorithm': 'fixed-indicator-state-v3',
                    'calculation_origin': 0, 'input_evidence': {'provider_snapshot_id': 'a' * 64, 'input_revision': 7}}}]}
    monkeypatch.setattr(provider_chart, 'data', lambda body: page)
    result = call(client, token, 'indicators_calculate', {'instrument': 'BTCUSDT', 'series_kind': 'provider',
        'timeframe': 'M1', 'indicators': [{'name': 'EMA', 'params': {'period': 2}}]})
    assert not result['isError'], result
    assert result['structuredContent']['page'] == page


def test_retired_watch_tools_are_absent_and_cannot_write(mcp):
    client, token, database = mcp
    names = {tool["name"] for tool in rpc(client, token, "tools/list").json()["result"]["tools"]}
    assert not names.intersection({"alerts_create", "alerts_cancel", "alerts_list"})
    for name in ("alerts_create", "alerts_cancel", "alerts_list"):
        assert call(client, token, name, {})["isError"]
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.Watch)) == 0
