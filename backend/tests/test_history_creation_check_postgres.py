"""Creation preflight and concurrent create-only commits on isolated PostgreSQL."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_history_creation_check as contracts
from alerts.history_api import ManagedRequest
from alerts.history_commands import CreationConflict, create_managed
from alerts.storage import DatasetMaintenance, HistoryRun, MarketDemand
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


def test_creation_preflight_and_replay(provider_pg):
    contracts.test_precision_date_and_catalog_check_stay_read_only(provider_pg[0])
    contracts.test_preflight_race_cannot_overwrite_plan_and_idempotency_still_works(provider_pg[0])


def test_parallel_create_only_keeps_one_plan_and_exact_replay(provider_pg):
    factory, _ = provider_pg

    def submit(number):
        body = ManagedRequest.model_validate(
            {
                "request_id": f"creation-race-{number}",
                "create_only": True,
                "dataset": {
                    key: value for key, value in contracts.draft().items() if key != "start_date"
                },
                "maintenance": {"target_start": 0, "timeframes": ["M1", "H4"], "frequency": "once"},
            }
        )
        try:
            with factory.begin() as db:
                result = create_managed(db, body)
            return body, result
        except CreationConflict:
            return body, None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, range(2)))
    winners = [(body, result) for body, result in results if result]
    assert len(winners) == 1
    body, winner = winners[0]
    with factory.begin() as db:
        replay = create_managed(db, body)
        assert replay["task"]["id"] == winner["task"]["id"]
        assert db.get(DatasetMaintenance, winner["dataset"]["id"]).timeframes == ["M1", "H4"]
        assert db.scalar(select(func.count()).select_from(HistoryRun)) == 1
        assert db.scalar(select(MarketDemand)) is None
