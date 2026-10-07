"""Maintenance agent permission, idempotency and browser transaction parity."""

from alerts.history_maintenance import configure
from alerts.mcp.auth import issue
from alerts.storage import AgentOperation, HistoryRun, HistoryVersion, MarketDemand, now_ms
from sqlalchemy import func, select
from test_market_contracts import identity
from test_market_datasets import register
from test_native_mcp import call, rpc
from test_native_mcp import mcp as mcp


def test_explicit_write_permission_and_idempotent_lifecycle(mcp):
    client, readonly, factory = mcp
    with factory.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])
    denied = call(client, readonly, "history_control_maintenance", {
        "dataset_id": identity().key, "action": "pause", "idempotency_key": "pause"})
    assert denied["isError"] and denied["structuredContent"]["error"]["code"] == "FORBIDDEN"
    writer = issue("history-write-test", ["market:read", "market:write"], now_ms() + 600000)
    tools = rpc(client, writer, "tools/list").json()["result"]["tools"]
    assert not next(row for row in tools if row["name"] == "history_submit_task")["annotations"]["readOnlyHint"]
    body = {"dataset_id": identity().key, "action": "pause", "idempotency_key": "pause"}
    first = call(client, writer, "history_control_maintenance", body)
    assert not first["isError"], first
    assert call(client, writer, "history_control_maintenance", body)["structuredContent"] == first["structuredContent"]
    conflict = call(client, writer, "history_control_maintenance", {**body, "action": "resume"})
    assert conflict["isError"] and conflict["structuredContent"]["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    current = client.get("/api/market-data/datasets/" + identity().key + "/maintenance").json()
    assert current == first["structuredContent"]
    task = {"dataset_id": identity().key, "kind": "backfill", "start": 0, "end": 120000,
        "idempotency_key": "finite-task"}
    submitted = call(client, writer, "history_submit_task", task)
    assert not submitted["isError"], submitted
    assert call(client, writer, "history_submit_task", task)["structuredContent"] == submitted["structuredContent"]
    version = submitted["structuredContent"]["id"]
    paused = call(client, writer, "history_control_task", {"version_id": version, "action": "pause", "idempotency_key": "pause-task"})
    assert not paused["isError"], paused
    invalid = call(client, writer, "history_request_artifacts", {"version_id": version,
        "timeframes": ["H4"], "idempotency_key": "premature"})
    assert invalid["isError"]
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(HistoryRun)) == 1
        assert db.scalar(select(MarketDemand)) is None
        assert not db.scalar(select(AgentOperation).where(AgentOperation.key == "premature"))


def writer_token(agent="history-write-test"):
    return issue(agent, ["market:read", "market:write"], now_ms() + 600000)


def test_namespaced_request_identity_has_no_delimiter_aliases():
    from types import SimpleNamespace

    from alerts.capabilities.history_writes import request_id

    left = request_id(SimpleNamespace(agent_id="one|create|two"), SimpleNamespace(idempotency_key="three"), "create")
    right = request_id(SimpleNamespace(agent_id="one"), SimpleNamespace(idempotency_key="two|create|three"), "create")
    assert left != right


def test_create_configure_cancel_and_agent_namespace(mcp):
    from alerts.aggregation_policy import history_dataset_identity

    client, _, factory = mcp
    writer = writer_token()
    body = {"dataset": {"source": "dukascopy", "logical_symbol": "EURUSD", "provider_symbol": "EURUSD",
        "asset_class": "forex", "precision": 5, "aggregation_calendar": "ny17"},
        "maintenance": {"target_start": 0, "timeframes": ["M1", "H4"], "frequency": "once"},
        "idempotency_key": "create-one"}
    created = call(client, writer, "history_create_dataset", body)
    assert not created["isError"], created
    result = created["structuredContent"]
    dataset, version = result["dataset"]["id"], result["task"]["id"]
    assert dataset == history_dataset_identity(source="dukascopy", provider_symbol="EURUSD",
        asset_class="forex", aggregation_calendar="ny17").key
    renewed = writer_token()  # same agent/key even through a new credential
    assert call(client, renewed, "history_create_dataset", body)["structuredContent"] == result
    configured = call(client, writer, "history_configure_maintenance", {"dataset_id": dataset,
        "maintenance": {**body["maintenance"], "daily_minute": 60}, "idempotency_key": "configure"})
    assert not configured["isError"], configured
    assert configured["structuredContent"]["daily_minute"] == 60
    cancelled = call(client, writer, "history_control_task", {"version_id": version,
        "action": "cancel", "idempotency_key": "cancel"})
    assert not cancelled["isError"], cancelled
    assert cancelled["structuredContent"]["desired_state"] == "cancelled"
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(HistoryRun)) == 1
        assert db.scalar(select(MarketDemand)) is None


def test_aggregation_artifacts_and_reference_guarded_reclamation(mcp):
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import import_page, snapshot_rows
    from alerts.storage import ChartWorkspace, HistoryReclamation
    from test_history_retention import prepared
    from test_history_versions import Adapter

    client, _, factory = mcp
    parent, instrument = prepared(factory)
    writer = writer_token()
    periods = call(client, writer, "history_request_artifacts", {"version_id": parent,
        "timeframes": ["D1"], "idempotency_key": "periods"})
    assert not periods["isError"], periods
    assert any(row["timeframe"] == "D1" for row in periods["structuredContent"]["periods"])
    while artifact_tick(parent):
        pass
    changed = call(client, writer, "history_change_aggregation", {"dataset_id": identity().key,
        "aggregation": {"aggregation_calendar": "utc0", "version_id": parent}, "idempotency_key": "calendar"})
    assert not changed["isError"], changed
    derived = changed["structuredContent"]["version"]["id"]
    while import_page(Adapter([]), version_id=derived):
        with factory() as db:
            if db.get(HistoryVersion, derived).status == "published":
                break
    with factory() as db:
        assert list(snapshot_rows(db, parent)) == list(snapshot_rows(db, derived))
    # Derived versions retain their original parent; both public and MCP guards
    # must refuse to erase the original prices despite paused/archived schedule.
    denied = call(client, writer, "history_reclaim_dataset", {"dataset_id": identity().key,
        "idempotency_key": "referenced"})
    assert denied["isError"]
    with factory() as db:
        assert db.get(HistoryReclamation, parent) is None
    # Separate destination with no business refs can be reclaimed after all
    # tasks finish; the shared source payload and original prices stay intact.
    destination = changed["structuredContent"]["dataset"]["id"]
    while artifact_tick(derived):
        pass
    for action in ("pause", "archive"):
        assert not call(client, writer, "history_control_maintenance", {"dataset_id": destination,
            "action": action, "idempotency_key": "destination-" + action})["isError"]
    reviewed = call(client, writer, "history_get_references", {"dataset_id": destination})["structuredContent"]
    with factory.begin() as db:
        db.add(ChartWorkspace(name="protect destination", document={"version": derived}))
    guard = call(client, writer, "history_reclaim_dataset", {"dataset_id": destination,
        "expected_review_revision": reviewed["impact"]["review_revision"], "idempotency_key": "saved-reference"})
    assert guard["isError"]
    error = guard["structuredContent"]["error"]
    assert error["code"] == "RECLAMATION_CHANGED"
    assert error["context"]["references"]["items"][0]["kind"] == "workspace"
    with factory.begin() as db:
        for row in db.scalars(select(ChartWorkspace)):
            db.delete(row)
    cleared = call(client, writer, "history_reclaim_dataset", {"dataset_id": destination,
        "idempotency_key": "clear-destination"})
    assert not cleared["isError"], cleared
    assert call(client, writer, "history_reclaim_dataset", {"dataset_id": destination,
        "idempotency_key": "clear-destination"})["structuredContent"] == cleared["structuredContent"]
    with factory() as db:
        assert db.get(HistoryReclamation, derived) and not db.get(HistoryReclamation, parent)
        assert list(snapshot_rows(db, parent))
        assert db.scalar(select(MarketDemand)) is None
