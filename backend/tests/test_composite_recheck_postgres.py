"""Source-recheck rollback and concurrent reservation in a task-local PG schema."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from sqlalchemy import select, func
from alerts import composite_recheck as module
from alerts import composite_preparation as preparation
from alerts.storage import CompositeRevision, CompositeReadAttempt
from test_composite_preparation import ready, answer
from test_provider_postgres import provider_pg as _provider_pg
from test_composite_recheck import test_failed_or_obsolete_rechecks_never_register_source_or_composite_prices as failed_contract
from test_composite_recheck import test_recheck_restores_same_fixed_alert_baseline_before_later_cross as recovery_contract
from test_composite_recheck import test_recheck_targets_unknown_minutes_before_spending_quota as gap_contract
from test_composite_recheck import test_successful_recheck_can_be_retried_after_its_gap_is_filled as idempotent_contract

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated Ubuntu PostgreSQL')


@pytest.mark.parametrize('failure', ['rate_limited', 'unauthorized', 'configuration', 'identity', 'window', 'expired'])
def test_failed_recheck_postgres(provider_pg, monkeypatch, failure):
    failed_contract(provider_pg[0], monkeypatch, failure)


def test_concurrent_rechecks_share_audit_and_serialize_rate_limit(provider_pg, monkeypatch):
    database = provider_pg[0]
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(module, 'now_ms', lambda: 165725000)
    ownership = preparation.claim(revision_id)
    preparation.commit(ownership, answer(ownership, rows=(), result={'status': 'empty_success'}))
    with database.begin() as db:
        composite_id = db.get(CompositeRevision, revision_id).composite_id
    began, finish = Event(), Event()
    calls = []
    def source(*args, **kwargs):
        calls.append(1)
        began.set()
        assert finish.wait(5)
        return answer(ownership, rows=(), result={'status': 'empty_success'})
    monkeypatch.setattr('alerts.source_history_store.shared_page', source)
    body = dict(request_id='concurrent', start=ownership['start'], end=ownership['end'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(module.recheck, composite_id, revision_id, body, object())
        assert began.wait(5)
        try:
            duplicate = module.recheck(composite_id, revision_id, body, object())
            assert duplicate['status'] == 'started' and duplicate['finished_at'] is None
            with pytest.raises(ValueError, match='间隔'):
                module.recheck(composite_id, revision_id, {**body, 'request_id': 'other'}, object())
        finally:
            finish.set()
        assert pending.result(timeout=5)['accepted']
    assert len(calls) == 1
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(CompositeReadAttempt).where(CompositeReadAttempt.read_kind == 'gap_recheck')) == 1


def test_source_recheck_fixed_alert_recovery_postgres(provider_pg, monkeypatch):
    recovery_contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize('covered', ['observed', 'target_closure', 'history_closure'])
def test_gap_targeting_postgres(provider_pg, monkeypatch, covered):
    gap_contract(provider_pg[0], monkeypatch, covered)


def test_filled_gap_idempotency_postgres(provider_pg, monkeypatch):
    idempotent_contract(provider_pg[0], monkeypatch)
