"""Run the new persistence contracts on isolated PostgreSQL schemas as well."""
import os

import pytest
from test_provider_postgres import provider_pg
from test_live_pricing import running
from test_notice_reliability import (
    test_confirmation_and_sampling_recover_only_their_own_operation,
    test_future_rejection_retains_cursor_and_bounded_retry,
    test_legacy_names_batch_search_changes_and_snapshot_survive_registry_loss,
    test_full_100_record_name_page_is_batched,
    test_sampling_evidence_is_safe_epoch_fenced_and_independent,
    test_unestablished_subscription_returns_specific_code_without_creating_composite,
)

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL')


@pytest.fixture
def database(provider_pg, monkeypatch):
    from alerts.config import settings
    monkeypatch.setattr(settings, 'fx_source', 'dukascopy')
    return provider_pg[0]
