import os

import pytest
from test_history_comparison import (
    test_comparison_uses_fixed_parent_and_discloses_partition_limits as contract,
)
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires Ubuntu isolated PostgreSQL")


def test_postgres_fixed_publication_comparison(provider_pg):
    contract(provider_pg[0])
