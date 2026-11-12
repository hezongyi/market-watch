"""Idle corrections against task-isolated PostgreSQL tables and real listeners."""
import os

import pytest
import test_composite_idle_regression as contracts
from alerts import storage
from alerts.publication_wakeup import COMPOSITE_CHANNEL, PublicationWakeup
from test_composite_aggregate_wakeup import confirm
from test_composite_chart import populated
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL')


@pytest.mark.parametrize('contract', [
    contracts.test_enabled_head_collects_without_browser_and_stops_on_disable,
    contracts.test_idle_pricing_keeps_not_due_auth_hold_visible,
    contracts.test_replayed_batch_only_aggregates_changed_price_minutes,
])
def test_idle_contract(provider_pg, monkeypatch, contract):
    factory, engine = provider_pg
    storage.bootstrap(engine)
    contract(factory, monkeypatch)


def test_empty_rounds_leave_no_schedule_rows(provider_pg):
    contracts.test_empty_indicator_workers_do_not_write_fairness_turns(provider_pg[0])


def test_actual_confirmed_input_wakes_composite_channel(provider_pg, monkeypatch):
    factory, engine = provider_pg
    _, revision, _ = populated(factory, monkeypatch)
    with PublicationWakeup(engine, channel=COMPOSITE_CHANNEL) as wake:
        assert confirm(factory, revision)
        assert wake.wait(1) == 'notification'
