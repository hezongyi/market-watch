"""Swing source/state contracts against a task-local PG schema, never production."""

import os

import pytest
import test_market_stream_worker as worker
import test_provider_service as provider
import test_swing_sr as swing
from alerts import storage
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    provider.test_four_swing_listeners_share_calculation_and_revision,
    worker.test_provider_swing_worker_uses_bar_revision_and_ignores_future_rows,
    swing.test_provider_page_keeps_full_statistics_and_source_chart_labels,
    swing.test_fixed_history_job_presentation_is_full_origin_when_paging,
    swing.test_fixed_composite_preview_is_page_independent_and_never_persisted,
])
def test_swing_contract_postgres(provider_pg, monkeypatch, contract):
    storage.bootstrap(provider_pg[1])
    contract(provider_pg[0], monkeypatch)


def test_swing_published_page_postgres(provider_pg):
    storage.bootstrap(provider_pg[1])
    swing.test_published_page_keeps_full_statistics(provider_pg[0])
