"""Price-policy acceptance against an isolated Ubuntu PostgreSQL schema."""

import os

import pytest
from test_history_artifacts import test_artifact_reuse_requires_compatible_version_price_rules as reuse_contract
from test_history_maintenance import (
    test_legacy_precision_failure_retry_freezes_rule_before_accepting_rows as retry_contract,
    test_legacy_precision_retry_rejects_active_writer_lease as lease_contract,
    test_legacy_resume_and_unrelated_retry_cannot_enable_rounding as control_contract,
)
from test_history_versions import (
    test_import_uses_frozen_version_precision_for_all_business_views as frozen_contract,
    test_legacy_import_cannot_round_before_rule_activation as legacy_contract,
)
from test_provider_postgres import provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [retry_contract, lease_contract, frozen_contract],
                         ids=lambda contract: contract.__name__)
def test_price_rule_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


@pytest.mark.parametrize("status", ["pending", "retrying"])
def test_legacy_import_policy(provider_pg, status):
    factory, _ = provider_pg
    legacy_contract(factory, status)


@pytest.mark.parametrize("action", ["resume", "retry"])
def test_legacy_control_policy(provider_pg, action):
    factory, _ = provider_pg
    control_contract(factory, action)


@pytest.mark.parametrize("parent_rule", ["legacy", "different_precision"])
def test_artifact_policy_compatibility(provider_pg, monkeypatch, parent_rule):
    factory, _ = provider_pg
    reuse_contract(factory, monkeypatch, parent_rule)
