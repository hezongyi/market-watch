"""Real HTTP/MCP adapters share config, lifecycle and atomic idempotency."""

from alerts import storage
from alerts.mcp.auth import issue
from sqlalchemy import func, select
from test_chart_alert_service import config
from test_native_mcp import call

pytest_plugins = ("test_native_mcp",)


def result(client, token, name, arguments):
    response = call(client, token, name, arguments)
    assert not response.get("isError"), response
    return response["structuredContent"]


def test_http_create_mcp_read_edit_and_http_lifecycle(mcp):
    from alerts.chart_alert_service import create

    client, token, database = mcp
    payload = config().model_dump(mode="json")
    created = client.post("/api/chart-alerts", json={"request_id": "web-rule", "config": payload})
    assert created.status_code == 422
    with database.begin() as db:
        ident = create(db, "legacy-web-rule", config(), at=0).id
    row = result(client, token, "chart_alerts_get", {"alert_id": ident})
    rejected = call(client, token, "chart_alerts_edit", {
        "idempotency_key": "edit-web", "alert_id": ident, "version": 1,
        "config": {**payload, "name": "MCP edited"},
    })
    assert rejected["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    assert client.get("/api/chart-alerts/" + ident).json() == row
    paused = result(client, token, "chart_alerts_lifecycle", {
        "idempotency_key": "web-pause", "request_id": "web-pause", "alert_id": ident,
        "version": 1, "control_revision": row["control_revision"], "action": "pause",
    })
    assert paused["status"] == "paused"
    archived = result(client, token, "chart_alerts_lifecycle", {
        "idempotency_key": "web-archive", "request_id": "web-archive", "alert_id": ident,
        "version": 1, "control_revision": paused["control_revision"], "action": "archive",
    })
    assert archived["status"] == "archived"
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.Watch)) == 0


def test_mcp_rejects_new_legacy_source_rules(mcp):
    client, token, database = mcp
    args = {"idempotency_key": "new-once", "request_id": "logical-once",
            "config": config().model_dump(mode="json")}
    response = call(client, token, "chart_alerts_create", args)
    assert response["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    cross = client.post("/api/chart-alerts", json={
        "request_id": args["request_id"], "config": args["config"],
    })
    assert cross.status_code == 422
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.ChartAlert)) == 0
        assert db.scalar(select(func.count()).select_from(storage.Watch)) == 0
        assert db.scalar(select(func.count()).select_from(storage.ChartAlertAction)) == 0
        assert db.scalar(select(func.count()).select_from(storage.AgentOperation)) == 0


def test_permissions_schema_source_binding_and_missing_association(mcp):
    client, token, database = mcp
    readonly = issue("readonly-chart-alerts", ["alerts:read"], storage.now_ms() + 600000)
    args = {"idempotency_key": "create", "request_id": "create",
            "config": config().model_dump(mode="json")}
    assert call(client, readonly, "chart_alerts_create", args)["structuredContent"]["error"]["code"] == "FORBIDDEN"
    for patch in ({"source": "binance"}, {"max_triggers": 99}, {"association": {
            "workspace_id": "missing", "chart_id": "missing", "generation": "1"}}):
        response = call(client, token, "chart_alerts_create", {**args, "config": {**args["config"], **patch}})
        assert response["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    invalid = call(client, token, "chart_alerts_create", {"idempotency_key": "old", "watch": {}})
    assert invalid["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.ChartAlert)) == 0
        assert db.scalar(select(func.count()).select_from(storage.AgentOperation)) == 0


def test_legacy_capabilities_are_visible_but_not_available_for_new_alerts(mcp):
    client, _, database = mcp
    with database.begin() as db:
        db.add(storage.Instrument(id="managed-only", symbol="managed-only", source="dukascopy",
            label="Managed archive", basis="bid", calendar="ny17", precision=5, enabled=True))
    response = client.post("/api/chart-alerts/capabilities", json={
        "instrument":"managed-only", "series_kind":"managed", "timeframe":"M5"})
    assert response.status_code == 200
    assert [(row["source"], row["series_kind"]) for row in response.json()["sources"]] == [("dukascopy", "managed")]
    assert response.json()["sources"][0]["available"] is False
    assert "已退役" in response.json()["sources"][0]["reason"]


def test_mcp_legacy_create_does_not_create_rule_or_outbox(mcp):
    client, token, database = mcp
    response = call(client, token, "chart_alerts_create", {
        "idempotency_key": "events", "request_id": "events",
        "config": config(notify_ntfy=True).model_dump(mode="json"),
    })
    assert response["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.ChartAlert)) == 0
        assert db.scalar(select(func.count()).select_from(storage.Outbox)) == 0


def test_geometry_and_association_cannot_bypass_shared_write_validation(mcp):
    from test_chart_alert_worker import seed

    client, token, database = mcp
    with database.begin() as db:
        seed(db, [9, 10, 11])
        db.add(storage.AdvancedWorkspace(id="bound", name="saved chart", document={
            "engine": "tv31", "schemaVersion": 1, "state": {
                "_mwAlertCharts": ["chart-uuid"], "charts": [{"symbol":"BTCUSDT", "panes":[{"sources":[
                    {"id":"study-id", "type":"Study", "state":{"name":"Moving Average"}}]}]}],
                "_mwDrawingProjection": {"version": 1, "charts": [{
                    "chart_id": "0", "symbol": "BTCUSDT", "resolution": "1", "drawings": []}]}}}))
    payload = config(instrument="BTCUSDT", source="binance", timeframe="M1",
        association={"workspace_id": "bound", "chart_id": "chart-uuid", "chart_index": 0,
                     "generation": "1:1"}).model_dump(mode="json")
    geometry = client.post("/api/chart-alerts/geometry", json={
        "instrument": "BTCUSDT", "source": "binance", "series_kind": "managed", "timeframe": "M1",
        "kind": "trend_line", "points": [{"time": 0, "price": "9"}, {"time": 120000, "price": "11"}],
    }).json()
    payload["condition"]["right"] = {"kind": "line", "line": geometry}
    bad_line = {**geometry, "points": [geometry["points"][0], {**geometry["points"][1], "index": 99}]}
    patches = [
        {"condition": {**payload["condition"], "right": {"kind": "line", "line": bad_line}}},
        {"association": {**payload["association"], "chart_id": "invented"}},
        {"association": {**payload["association"], "chart_index": 7}},
        {"association": {**payload["association"], "object_kind": "drawing", "object_id": "id", "native_object_id": "missing"}},
        {"association": {**payload["association"], "object_kind": "indicator", "object_id": "id", "native_object_id": "BTCUSDT"}},
    ]
    for index, patch in enumerate(patches):
        cfg = {**payload, **patch}
        args = {"idempotency_key": "invalid-"+str(index), "request_id": "invalid-"+str(index), "config": cfg}
        assert call(client, token, "chart_alerts_create", args)["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
        assert client.post("/api/chart-alerts", json={"request_id": args["request_id"], "config": cfg}).status_code == 422
    rejected = call(client, token, "chart_alerts_create", {
        "idempotency_key": "verified", "request_id": "verified", "config": payload})
    assert rejected["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    discovered = result(client, token, "charts_get_drawings", {"workspace_id":"bound", "engine":"native"})
    assert discovered["charts"][0]["chart_id"] == "chart-uuid"
    indicator = {**payload, "association":{**payload["association"], "chart_index":None,
        "object_kind":"indicator", "object_id":"object-uuid", "native_object_id":"study-id"}}
    assert client.post("/api/chart-alerts", json={"request_id":"indicator", "config":indicator}).status_code == 422
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.ChartAlert)) == 0
        assert db.scalar(select(func.count()).select_from(storage.ChartAlertVersion)) == 0
