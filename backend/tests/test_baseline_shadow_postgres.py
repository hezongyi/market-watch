"""Ubuntu isolated PostgreSQL Sunday-candidate shadow evidence.

Each contract runs in its own unique schema, so failed reports, retained rows and
switch-run JSON never leak between them.
"""

import os

import pytest
import test_baseline_shadow as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")

CONTRACTS = [
    contracts.test_report_contains_every_required_shadow_field,
    contracts.test_live_bindings_are_snapshotted_and_unchanged,
    contracts.test_unready_candidate_reports_reasons_without_binding_changes,
    contracts.test_latest_version_beyond_cutoff_is_reported_without_a_candidate,
    contracts.test_shadow_failure_is_recorded_not_raised,
    contracts.test_rerun_reuses_one_run_and_overwrites_its_report,
    contracts.test_rewritten_history_price_is_counted_with_its_delta,
    contracts.test_gap_list_reports_missing_minutes_and_uncovered_intervals,
]


@pytest.mark.parametrize("contract", CONTRACTS, ids=[case.__name__ for case in CONTRACTS])
def test_shadow_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_switch_run_report_is_durable_json_with_indexed_dedupe(provider_pg, monkeypatch):
    from alerts import baseline_shadow, switch_runs
    from alerts.storage import MarketSwitchRun
    from sqlalchemy import func, select

    factory, engine = provider_pg
    composite, active, candidate, plan, _ = contracts.candidate_fixture(factory, monkeypatch)
    first = baseline_shadow.shadow(composite, scheduled_for=contracts.STAMP)
    second = baseline_shadow.shadow(composite, scheduled_for=contracts.STAMP)
    assert first["run"]["id"] == second["run"]["id"]
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        stored = switch_runs.get(first["run"]["id"])
        assert stored["state"] == "shadow_ready" and stored["attempts"] == 0
        assert stored["shadow_report"]["schema"] == baseline_shadow.SCHEMA
        assert stored["shadow_report"]["bars"]["frames"][0]["target"]["status"] == "compared"
        assert stored["shadow_report"]["bindings"]["critical_unchanged"] is True
        assert stored["shadow_report"]["paused_rules"]
    with engine.connect() as connection:
        plan_rows = connection.exec_driver_sql(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'market_switch_runs'").scalars()
        assert {"ix_market_switch_run_unlock", "ix_market_switch_run_dedupe"} <= set(plan_rows)
