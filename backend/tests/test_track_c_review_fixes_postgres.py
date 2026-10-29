"""PR115 regression acceptance in unique PostgreSQL schemas, with real locks."""

import os

import pytest
import test_track_c_review_fixes as contracts
from alerts import composite_alerts
from alerts.storage import ChartAlert, ChartAlertVersion
from sqlalchemy import select, text
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [contracts.contract_unrelated_source,
                                      contracts.contract_raw_page_cleanup,
                                      contracts.contract_page_boundary_and_orphans,
                                      contracts.contract_blob_scan_resumes_past_retained_prefix,
                                      contracts.contract_old_products_preserve_history_and_active_refs])
def test_retention_regression(provider_pg, contract):
    contract(provider_pg[0])


@pytest.mark.parametrize("contract", [contracts.test_old_candidate_and_preparation_rejected,
                                      contracts.test_failed_shadow_notifies_once,
                                      contracts.test_superseded_candidate_stops_fanout,
                                      contracts.test_expired_inputs_are_unavailable,
                                      contracts.test_shadow_failure_pauses_only_expired_binding])
def test_switch_regression(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_switch_does_not_lock_unrelated_alert(provider_pg):
    factory, _ = provider_pg
    with factory.begin() as db:
        for name in ("a", "b"):
            db.add(ChartAlert(id=name, request_id=name, request_hash=name, name=name,
                              status="active", effective_at=1))
        db.flush()
        for name in ("a", "b"):
            db.add(ChartAlertVersion(alert_id=name, version=1, config={},
                market_identity={"composite_id": name}, effective_at=1))
    with factory.begin() as switch:
        assert len(composite_alerts.bound_rules(switch, "a", lock=True)) == 1
        with factory.begin() as evaluator:
            evaluator.execute(text("SET LOCAL lock_timeout='1s'"))
            assert evaluator.scalar(select(ChartAlert.id).where(ChartAlert.id == "b")
                                    .with_for_update(skip_locked=True)) == "b"
