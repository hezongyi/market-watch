"""Shared cooldown and durable resumption against an isolated PostgreSQL schema."""
import os
import pytest
from alerts import provider_chart as upstream
from alerts.config import settings
from test_provider_cache import META, page
from test_provider_postgres import provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL')


def test_cooldown_releases_worker_and_resumes_durable_history(provider_pg, monkeypatch):
    from test_market_resources import test_source_cooldown_yields_immediately_instead_of_spending_request_budget
    factory, _ = provider_pg
    test_source_cooldown_yields_immediately_instead_of_spending_request_budget(factory, monkeypatch)


def test_durable_history_recovery_at_cooldown_end(provider_pg, monkeypatch):
    from test_native_history_loads import test_cooling_source_waits_until_eligible_without_spending_stall_budget
    factory, _ = provider_pg
    monkeypatch.setattr(settings, 'native_history_max_bars', 80000)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    test_cooling_source_waits_until_eligible_without_spending_stall_budget(factory, monkeypatch)


def test_subscription_schedules_cooldown_end(provider_pg, monkeypatch):
    from test_provider_service import test_cooling_subscription_schedules_recovery_at_source_retry_time
    factory, _ = provider_pg
    test_cooling_subscription_schedules_recovery_at_source_retry_time(factory, monkeypatch)
