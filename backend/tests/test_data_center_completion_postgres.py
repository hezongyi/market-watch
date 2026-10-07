"""Server-side task filters, real timestamps and creation reconciliation on PG."""
import os

import pytest
import test_data_center as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_task_filters_before_pagination_include_period_derivation,
    contracts.test_task_times_record_real_processing_and_not_poll_time,
    contracts.test_atomic_create_rolls_back_invalid_maintenance_and_retry_returns_fixed_task,
])
def test_postgres_task_management(provider_pg, contract):
    contract(provider_pg[0])
