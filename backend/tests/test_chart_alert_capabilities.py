"""Real HTTP/MCP adapters share config, lifecycle and atomic idempotency."""

from concurrent.futures import ThreadPoolExecutor

from alerts import storage
from alerts.mcp.auth import issue
from sqlalchemy import func, select
from test_chart_alert_service import config, sample
from test_native_mcp import call

pytest_plugins = ("test_native_mcp",)


def result(client, token, name, arguments):
    response = call(client, token, name, arguments)
    assert not response.get("isError"), response
    return response["structuredContent"]


def test_http_create_mcp_read_edit_and_http_lifecycle(mcp):
    client, token, database = mcp
    payload = config().model_dump(mode="json")
    created = client.post("/api/chart-alerts", json={"request_id": "web-rule", "config": payload})
    assert created.status_code == 201, created.text
    row = created.json()
    assert result(client, token, "chart_alerts_get", {"alert_id": row["id"]}) == row
    changed = result(client, token, "chart_alerts_edit", {
        "idempotency_key": "edit-web", "alert_id": row["id"], "version": 1,
        "config": {**payload, "name": "MCP edited"},
    })
    assert changed["version"] == 2
    assert client.get("/api/chart-alerts/" + row["id"]).json() == changed
    conflict = call(client, token, "chart_alerts_edit", {
        "idempotency_key": "stale-edit", "alert_id": row["id"], "version": 1, "config": payload,
    })
    assert conflict["structuredContent"]["error"]["code"] == "BUSINESS_CONFLICT"
    response = client.post(f"/api/chart-alerts/{row['id']}/lifecycle", json={
        "request_id": "web-pause", "version": 2,
        "control_revision": changed["control_revision"], "action": "pause",
    })
    assert response.status_code == 200, response.text
    assert result(client, token, "chart_alerts_get", {"alert_id": row["id"]})["status"] == "paused"
    assert result(client, token, "chart_alerts_list", {"status": "paused"})["items"][0]["id"] == row["id"]
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.Watch)) == 0


def test_mcp_create_retries_concurrency_and_lifecycle_share_one_rule(mcp):
    client, token, database = mcp
    args = {"idempotency_key": "new-once", "request_id": "logical-once",
            "config": config().model_dump(mode="json")}
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(lambda _: result(client, token, "chart_alerts_create", args), range(3)))
    assert len({row["id"] for row in rows}) == 1
    row = rows[0]
    assert client.get("/api/chart-alerts/" + row["id"]).json() == row
    conflict = call(client, token, "chart_alerts_create", {
        **args, "config": config(name="different intent").model_dump(mode="json"),
    })
    assert conflict["structuredContent"]["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    cross = client.post("/api/chart-alerts", json={
        "request_id": args["request_id"], "config": args["config"],
    })
    assert cross.status_code == 201 and cross.json()["id"] == row["id"]
    lifecycle = {"idempotency_key": "pause-once", "alert_id": row["id"], "version": 1,
                 "control_revision": row["control_revision"], "request_id": "pause-once", "action": "pause"}
    paused = result(client, token, "chart_alerts_lifecycle", lifecycle)
    assert paused["status"] == "paused"
    assert result(client, token, "chart_alerts_lifecycle", lifecycle) == paused
    assert client.get("/api/chart-alerts/" + row["id"]).json() == paused
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.ChartAlert)) == 1
        assert db.scalar(select(func.count()).select_from(storage.Watch)) == 0
        assert db.scalar(select(func.count()).select_from(storage.ChartAlertAction)) == 1
        assert db.scalar(select(func.count()).select_from(storage.AgentOperation)) == 2


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


def test_duplicate_observations_have_one_event_and_outbox_across_adapters(mcp):
    from alerts.chart_alert_service import consume

    client, token, database = mcp
    row = result(client, token, "chart_alerts_create", {
        "idempotency_key": "events", "request_id": "events",
        "config": config(notify_ntfy=True).model_dump(mode="json"),
    })
    with database.begin() as db:
        at = row["effective_at"]
        baseline = sample(0, 9)
        crossing = sample(1, 11)
        from dataclasses import replace
        baseline = replace(baseline, occurred_at=at)
        crossing = replace(crossing, occurred_at=at + 300000)
        consume(db, row["id"], baseline, detected_at=at)
        consume(db, row["id"], crossing, detected_at=at + 300001)
        consume(db, row["id"], crossing, detected_at=at + 300002)
    events = result(client, token, "chart_alerts_events", {"alert_id": row["id"]})["items"]
    assert events == client.get("/api/chart-alerts/events?alert_id=" + row["id"]).json()
    assert len(events) == 1
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.Outbox)) == 1
        assert db.get(storage.ChartAlert, row["id"]).count == 1


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
    row = result(client, token, "chart_alerts_create", {
        "idempotency_key": "verified", "request_id": "verified", "config": payload})
    assert row["config"] == config(**payload).model_dump(mode="json")
    discovered = result(client, token, "charts_get_drawings", {"workspace_id":"bound", "engine":"native"})
    assert discovered["charts"][0]["chart_id"] == "chart-uuid"
    indicator = {**payload, "association":{**payload["association"], "chart_index":None,
        "object_kind":"indicator", "object_id":"object-uuid", "native_object_id":"study-id"}}
    assert client.post("/api/chart-alerts", json={"request_id":"indicator", "config":indicator}).status_code == 201
    assert client.post("/api/chart-alerts/"+row["id"]+"/edit", json={
        "version": 1, "config": {**payload, **patches[0]}}).status_code == 422
    with database() as db:
        assert db.scalar(select(func.count()).select_from(storage.ChartAlert)) == 2
        assert db.scalar(select(func.count()).select_from(storage.ChartAlertVersion)) == 2
