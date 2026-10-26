"""A pending leased page retains timing evidence on real isolated PostgreSQL."""
import os

import pytest
from alerts import provider_chart as upstream
from alerts.config import settings
from test_native_history_loads import (
    test_pending_turn_retains_fill_timings_and_final_result_contract as check_pending_turn,
)
from test_native_history_loads import (
    test_result_poll_preserves_progress_and_final_page_count as check_result_poll,
)
from test_native_history_loads import (
    test_shared_source_acquisition_busy_waits_then_completes as check_source_busy,
)
from test_provider_cache import META, page
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated Ubuntu PostgreSQL')


def test_pending_turn_metrics_and_result_contract(provider_pg, caplog, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(settings, 'native_history_max_bars', 80000)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda m, f, b, n, **k: page(b-n*1000, b))
    check_pending_turn(factory, caplog, monkeypatch)


def test_result_poll_progress_and_final_pages(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(settings, 'native_history_max_bars', 80000)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda m, f, b, n, **k: page(b-n*1000, b))
    check_result_poll(factory)


def test_shared_source_busy_retries_without_terminal_failure(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(settings, 'native_history_max_bars', 80000)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda m, f, b, n, **k: page(b-n*1000, b))
    check_source_busy(factory, monkeypatch)
