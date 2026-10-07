import os

import pytest
import test_history_reclamation_impact as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires Ubuntu isolated PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_impact_reports_exact_versions_periods_and_unique_shared_content,
    contracts.test_new_publication_invalidates_review_without_expanding_deletion,
    contracts.test_http_conflict_returns_new_dependency_and_preserves_prices,
])
def test_postgres_reviewed_reclamation(provider_pg, contract):
    contract(provider_pg[0])
