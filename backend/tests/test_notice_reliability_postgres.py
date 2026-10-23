"""Run the new persistence contracts on isolated PostgreSQL schemas as well."""
import os

import pytest
from test_live_pricing import running as _running
from test_notice_reliability import (
    test_confirmation_and_sampling_recover_only_their_own_operation as test_confirmation_and_sampling_recover_only_their_own_operation,
)
from test_notice_reliability import (
    test_full_100_record_name_page_is_batched as test_full_100_record_name_page_is_batched,
)
from test_notice_reliability import (
    test_future_rejection_retains_cursor_and_bounded_retry as test_future_rejection_retains_cursor_and_bounded_retry,
)
from test_notice_reliability import (
    test_legacy_names_batch_search_changes_and_snapshot_survive_registry_loss as test_legacy_names_batch_search_changes_and_snapshot_survive_registry_loss,
)
from test_notice_reliability import (
    test_sampling_evidence_is_safe_epoch_fenced_and_independent as test_sampling_evidence_is_safe_epoch_fenced_and_independent,
)
from test_notice_reliability import (
    test_unestablished_subscription_returns_specific_code_without_creating_composite as test_unestablished_subscription_returns_specific_code_without_creating_composite,
)
from test_provider_postgres import provider_pg as _provider_pg

# Explicitly retain pytest's imported fixtures and six collected test contracts.
provider_pg = _provider_pg
running = _running

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL')


@pytest.fixture
def database(provider_pg, monkeypatch):
    from alerts.config import settings
    monkeypatch.setattr(settings, 'fx_source', 'dukascopy')
    return provider_pg[0]
