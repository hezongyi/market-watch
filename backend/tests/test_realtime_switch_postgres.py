"""Persisted choices and blocked writers in an isolated real PostgreSQL schema."""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_realtime_switch as contracts
from alerts import storage
from alerts.chart_alert_service import lifecycle
from alerts.managed_dataset import join
from alerts.realtime_switch import enabled, preference_key, set_enabled
from alerts.storage import Audit, ChartAlert, ChartHistoryPlan, Instrument, Preference
from sqlalchemy import func, select, text
from test_composite_alerts import armed
from test_managed_dataset import START
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated Ubuntu PostgreSQL')


@pytest.fixture
def switch_pg(provider_pg):
    factory, engine = provider_pg
    storage.bootstrap(engine)
    return factory


@pytest.mark.parametrize('contract', [
    contracts.test_http_switch_is_strict_idempotent_and_does_not_authorize_history,
    contracts.test_composite_compatibility_and_off_remove_live_targets_but_keep_history,
    contracts.test_disabled_composite_never_captures_provisional_snapshot,
    contracts.test_running_rule_pauses_once_off_and_reenable_needs_explicit_resume,
    contracts.test_stale_creation_is_rejected,
    contracts.test_expired_input_pauses_even_while_preparation_is_pending,
    contracts.test_known_closed_session_does_not_pause_on_old_input,
    contracts.test_rest_candle_freshness_does_not_require_a_quote,
    contracts.test_capability_reports_stale_source_unavailable,
    contracts.test_compatibility_snapshot_survives_lease_expiry_and_repeated_bootstrap,
    contracts.test_ordinary_collection_and_repairs_skip_off_but_history_is_not_starved,
])
def test_switch_contract(switch_pg, monkeypatch, contract):
    contract(switch_pg, monkeypatch)


@pytest.mark.parametrize('consumer', ['none', 'expired', 'chart', 'alert'])
def test_migration_defaults(switch_pg, monkeypatch, consumer):
    contracts.test_compatibility_default_requires_existing_live_consumers(switch_pg, monkeypatch, consumer)


@pytest.mark.parametrize('mode', ['close', 'intrabar'])
def test_stale_sample(switch_pg, monkeypatch, mode):
    contracts.test_stale_input_pauses_without_event_or_automatic_recovery(switch_pg, monkeypatch, mode)


@pytest.mark.parametrize('action', ['resume', 'restart', 'rebaseline'])
def test_admission(switch_pg, monkeypatch, action):
    contracts.test_disabled_rules_reject_create_and_resume_without_mutating_counters(switch_pg, monkeypatch, action)


@pytest.mark.parametrize('existing', [True, False])
def test_maintenance(switch_pg, existing):
    contracts.test_history_join_and_progress_preserve_explicit_off(switch_pg, existing)


def wait_for_blocked_writer(db, pid):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if db.scalar(text('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=:pid AND NOT granted)'), {'pid': pid}):
            return
        threading.Event().wait(0.01)
    pytest.fail('contending writer did not reach the actual PostgreSQL lock')


@pytest.mark.parametrize('operation', ['disable', 'join'])
def test_disable_serializes_with_stale_choice_and_maintenance(switch_pg, operation):
    factory = switch_pg
    stamp = START + 30 * 60000 + 5000
    with factory.begin() as db:
        join(db, db.get(Instrument, 'BTCUSDT'), START, stamp)
        set_enabled(db, 'BTCUSDT', True, now=stamp)
        before = db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == 'managed_realtime_changed'))
    loaded, proceed = threading.Event(), threading.Event()
    waiter_pid = []

    def contender():
        with factory.begin() as db:
            # Retain stale ORM objects across the lock wait on purpose.
            choice = db.get(Preference, preference_key('BTCUSDT'))
            plan = db.get(ChartHistoryPlan, 'BTCUSDT')
            assert choice.value['enabled'] and plan.realtime_enabled
            waiter_pid.append(db.scalar(text('SELECT pg_backend_pid()')))
            loaded.set()
            assert proceed.wait(4)
            if operation == 'disable':
                set_enabled(db, 'BTCUSDT', False, now=stamp + 2)
            else:
                join(db, db.get(Instrument, 'BTCUSDT'), START, stamp + 2)

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(contender)
        try:
            assert loaded.wait(4)
            with factory.begin() as db:
                set_enabled(db, 'BTCUSDT', False, now=stamp + 1)
                proceed.set()
                wait_for_blocked_writer(db, waiter_pid[0])
                assert not pending.done()
        finally:
            proceed.set()
        pending.result(timeout=5)
    with factory() as db:
        assert not enabled(db, 'BTCUSDT')
        assert not db.get(ChartHistoryPlan, 'BTCUSDT').realtime_enabled
        assert db.scalar(select(func.count()).select_from(Audit).where(
            Audit.kind == 'managed_realtime_changed')) == before + 1


def test_resume_cannot_use_preloaded_choice_after_concurrent_disable(switch_pg, monkeypatch):
    factory = switch_pg
    ident, _, revision, _, stamp = armed(factory, monkeypatch)
    with factory.begin() as db:
        row = db.get(ChartAlert, ident)
        row.status = 'paused'
        sid = contracts.source_id(db, revision)
        control = row.control_revision
    loaded, proceed = threading.Event(), threading.Event()
    waiter_pid = []

    def resume():
        with factory.begin() as db:
            choice = db.get(Preference, preference_key(sid))
            assert choice.value['enabled']
            waiter_pid.append(db.scalar(text('SELECT pg_backend_pid()')))
            loaded.set()
            assert proceed.wait(4)
            with pytest.raises(ValueError, match='实时流已关闭'):
                lifecycle(db, ident, 1, 'resume', expected_revision=control,
                    request_id='blocked-resume', at=stamp + 2)

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(resume)
        try:
            assert loaded.wait(4)
            with factory.begin() as db:
                set_enabled(db, sid, False, now=stamp + 1)
                proceed.set()
                wait_for_blocked_writer(db, waiter_pid[0])
        finally:
            proceed.set()
        pending.result(timeout=5)
    with factory() as db:
        assert db.get(ChartAlert, ident).status == 'paused'
        assert db.get(ChartAlert, ident).control_revision == control
