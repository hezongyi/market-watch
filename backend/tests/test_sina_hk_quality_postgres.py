"""The HK audit snapshot and provider-cache contracts on a task-owned PG schema."""

import os

import pytest
import test_sina_hk_quality as checks
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires task-owned PostgreSQL')


@pytest.mark.parametrize('check', [
    checks.test_real_bad_historical_rows_do_not_block_recent_platform_or_cached_reads,
    checks.test_hk_audit_reaches_provider_cache_and_metadata_without_changing_ticker,
])
def test_hk_quality_persistence_on_postgres(provider_pg, monkeypatch, check):
    check(provider_pg[0], monkeypatch)


@pytest.mark.parametrize('payload', [checks.records()[:2], []])
def test_hk_invalid_snapshot_recovery_on_postgres(provider_pg, monkeypatch, payload):
    checks.test_no_valid_hk_snapshot_is_retryable_and_not_cached_as_empty_success(
        provider_pg[0], monkeypatch, payload)
