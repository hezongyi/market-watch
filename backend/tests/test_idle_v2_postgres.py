"""Confirmed cache must retain authoritative input semantics on PostgreSQL too."""
import os

import pytest
from test_idle_v2_regression import (
    test_confirmed_cache_cannot_leak_new_input_into_an_older_retry as old_retry,
)
from test_idle_v2_regression import (
    test_confirmed_worker_reuses_calendar_and_only_replaces_changed_inputs as contract,
)
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL')

@pytest.mark.parametrize('frame', ['M5', 'H4', 'W1', 'MN'])
def test_incremental_inputs(provider_pg, monkeypatch, frame):
    contract(provider_pg[0], monkeypatch, frame)

def test_fixed_input_retry(provider_pg, monkeypatch):
    old_retry(provider_pg[0], monkeypatch)
