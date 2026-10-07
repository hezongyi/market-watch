"""Actual isolated PostgreSQL maintenance MCP contracts and write contention."""

import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_history_writes_mcp as contracts
from alerts import api
from alerts.capabilities.actions import build_registry
from alerts.capabilities.context import CallContext, CapabilityError
from alerts.mcp.adapter import write_operation
from alerts.mcp.auth import digest
from alerts.storage import AgentOperation, HistoryRun, MarketDataset, MarketDemand, SourceSeries
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.fixture
def mcp_pg(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(api.settings, "fx_source", "dukascopy")
    monkeypatch.setattr(api.settings, "mcp_enabled", True)
    monkeypatch.setattr(api.settings, "mcp_calls_per_minute", 600)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app, base_url="http://127.0.0.1:8000") as client:
            yield client, contracts.issue("reader", ["market:read"], contracts.now_ms() + 600000), factory
    finally:
        api.app.dependency_overrides.clear()


@pytest.mark.parametrize("contract", [
    contracts.test_explicit_write_permission_and_idempotent_lifecycle,
    contracts.test_create_configure_cancel_and_agent_namespace,
    contracts.test_aggregation_artifacts_and_reference_guarded_reclamation,
])
def test_http_contract(mcp_pg, contract):
    contract(mcp_pg)


def test_concurrent_renewed_credentials_and_partial_failure_rollback(provider_pg):
    factory, _ = provider_pg
    registry = build_registry()
    tokens = [contracts.writer_token() for _ in range(4)]
    contexts = [CallContext("history-write-test", digest(token), frozenset({"market:read", "market:write"}),
        "request-" + str(i), time.monotonic() + 60) for i, token in enumerate(tokens)]
    cap = registry.resolve("history_create_dataset", contexts[0].scopes)
    intent = {"dataset": {"source": "dukascopy", "logical_symbol": "EURUSD", "provider_symbol": "EURUSD",
        "asset_class": "forex", "precision": 5},
        "maintenance": {"target_start": 0, "timeframes": ["M1"], "frequency": "once"},
        "idempotency_key": "concurrent-create"}
    # Registration inserts the source and instrument before validating periods;
    # failure must roll those real effects back, not merely omit AgentOperation.
    invalid = cap.input_model.model_validate({**intent,
        "maintenance": {**intent["maintenance"], "timeframes": ["BAD"]}})
    with pytest.raises(CapabilityError, match="周期"):
        write_operation(contexts[0], cap, invalid)
    with factory() as db:
        for model in (AgentOperation, HistoryRun, MarketDataset, SourceSeries):
            assert db.scalar(select(func.count()).select_from(model)) == 0
    body = cap.input_model.model_validate(intent)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda ctx: write_operation(ctx, cap, body), contexts * 2))
    assert all(result == results[0] for result in results)
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(AgentOperation)) == 1
        assert db.scalar(select(func.count()).select_from(HistoryRun)) == 1
        assert db.scalar(select(func.count()).select_from(MarketDataset)) == 1
        assert db.scalar(select(MarketDemand)) is None
