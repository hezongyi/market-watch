"""Actual PG switch activation: one durable run, one report, late writes fenced."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_switch_activation as contracts
from alerts.composite_aggregates import Fenced, commit
from alerts.composite_inputs import frozen
from alerts.composite_revisions import activate
from alerts.storage import (
    CompositeActivation,
    CompositeAggregateBar,
    CompositePreparation,
    MarketComposite,
    MarketSwitchRun,
    Notification,
    Outbox,
)
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_activation_binds_one_state_and_freezes_the_previous,
    contracts.test_partial_failure_rolls_back_and_never_unlocks,
    contracts.test_retries_keep_one_message_and_merge_distinct_errors,
    contracts.test_incompatible_source_is_rejected_without_touching_rules,
    contracts.test_fenced_revision_refuses_late_input_and_aggregate_commits,
    contracts.test_relocatable_requires_a_published_period_and_a_caught_up_waterline,
    contracts.test_rule_the_target_cannot_serve_is_paused_and_reported,
    contracts.test_relocation_never_replays_a_pre_switch_crossing,
    contracts.test_forward_history_version_rebinds_without_pausing,
    contracts.test_calendar_change_pauses_the_running_rule,
])
def test_activation_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_concurrent_activation_keeps_one_run_and_refuses_late_writes(provider_pg, monkeypatch):
    factory, _ = provider_pg
    composite, old, ident, _ = contracts.candidate(factory, monkeypatch)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: contracts.STAMP)

    def activate_once(_):
        with factory.begin() as db:
            return activate(db, composite, ident, {"request_id": "pg-switch",
                "expected_revision_id": old}).revision_id

    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(activate_once, range(4))) == [ident] * 4
    with factory() as db:
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 1
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        run = db.scalar(select(MarketSwitchRun))
        assert (run.state, run.phase, run.attempts) == ("succeeded", "activated", 0)
        assert db.scalar(select(func.count()).select_from(Notification)) == 0
        assert db.scalar(select(func.count()).select_from(Outbox)) == 0
        assert frozen(db.get(CompositePreparation, old))
        waterline = db.get(CompositePreparation, old).input_revision
        bars = db.scalar(select(func.count()).select_from(CompositeAggregateBar))
        stale = {"revision_id": old, "composite_id": composite,
                 "permission_scope": "workspace:default", "timeframe": "M1",
                 "input_revision": waterline, "offset": 0, "token": "stale-claim",
                 "buckets": [(0, 60000)], "total": 1}
    with pytest.raises(Fenced, match="已冻结"):
        with factory.begin() as db:
            commit(stale, [])
    recorded, applied = contracts.late_batch(factory, old, 199980000)
    with factory() as db:
        assert not [item for item in applied if item["revision_id"] == old]
        assert db.get(CompositePreparation, old).input_revision == waterline
        assert db.scalar(select(func.count()).select_from(CompositeAggregateBar)) == bars
