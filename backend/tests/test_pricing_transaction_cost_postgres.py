"""The quote transaction contracts also run on isolated PostgreSQL."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_pricing_transaction_cost as contracts
from test_live_pricing import running as live_running
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires task-owned PostgreSQL')


@pytest.fixture
def running(provider_pg, monkeypatch):
    return live_running.__wrapped__(provider_pg[0], monkeypatch)


def test_steady_quote(running):
    contracts.test_steady_quote_reads_once_and_flushes_complete_snapshot(running)


@pytest.mark.parametrize('source,bid,ask,tradeable,displayed', [
    (180001, '1.20', '1.40', True, True),
    (122000, '1.20', '1.40', False, False),
    (122000, None, None, True, False),
    (122000, '1.50', '1.40', True, False),
])
def test_admission(running, source, bid, ask, tradeable, displayed):
    contracts.test_preloaded_minutes_preserve_display_admission(running, source, bid, ask, tradeable, displayed)


def test_rollback(running, monkeypatch):
    contracts.test_cached_quote_failure_rolls_back_all_snapshots(running, monkeypatch)


def test_epoch_capacity(running, monkeypatch):
    contracts.test_cached_quote_capacity_and_new_epoch_keep_separate_fragments(running, monkeypatch)


@pytest.mark.parametrize('quote_first', [False, True])
def test_quote_and_confirmation_preserve_shared_state(running, monkeypatch, quote_first):
    from alerts import live_pricing as live
    from alerts.storage import LiveMinute, LiveState
    from sqlalchemy import select
    from test_live_pricing import candles, quote
    from test_market_contracts import minute

    factory, owner, epoch, identities = running
    identity, completed = identities['EUR_USD'], set()
    for seq in (1, 2):
        live.publish_event(owner, epoch, quote(identity, epoch, seq=seq, source=121000+seq),
                           identities, now=125000, completed_handovers=completed)
    assert live.renew(owner, now=150000)
    assert live.renew(owner, now=175000)
    held, release, waiting = threading.Event(), threading.Event(), threading.Event()
    original = live._lock_live_datasets

    def gate(db, rows, *, confirmation=False):
        result = original(db, rows, confirmation=confirmation)
        if confirmation != quote_first:
            held.set()
            assert release.wait(10)
        return result

    monkeypatch.setattr(live, '_lock_live_datasets', gate)

    def publish():
        return live.publish_event(owner, epoch,
            quote(identity, epoch, seq=3, source=179999, received_at=185000, bid='1.20'),
            identities, now=185000, completed_handovers=completed)

    def confirm():
        return live.commit_confirmation(owner, epoch,
            candles(identity, window_start=120000, window_end=180000,
                    rows=(minute(120000, volume='4'),), checkpoint=180000, observed_at=185000),
            now=185000)

    def second(action):
        waiting.set()
        return action()

    first, other = (publish, confirm) if quote_first else (confirm, publish)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(first)
        assert held.wait(10)
        b = pool.submit(second, other)
        try:
            assert waiting.wait(10)
            assert not b.done()
        finally:
            release.set()
        a.result(timeout=15)
        b.result(timeout=15)
    with factory() as db:
        state = db.get(LiveState, identity.key)
        metric = db.scalar(select(LiveMinute).where(
            LiveMinute.dataset_id == identity.key, LiveMinute.start == 120000))
        assert state.confirmed_end == 180000 and state.quote['sequence'] == 3
        assert metric.quote_count == 3 and metric.confirmed_at == 185000
        assert metric.attempts == 1 and metric.expected is True
