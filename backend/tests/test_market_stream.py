"""Exercise shared publication, cancellation fencing and bounded recovery."""

import pytest
from alerts import market_stream as stream
from alerts.storage import LoginSession, MarketStreamSubscription, MarketStreamTask
from sqlalchemy import func, select


def session(database, key="session"):
    with database.begin() as db:
        db.add(LoginSession(token_hash=key, csrf="csrf", expires=stream.now_ms() + 1000000))
    return key


def register(owner, client="page", listener="chart", generation=1, state=None):
    return stream.register(owner, client, listener, generation,
                           {"kind": "bars", "dataset": "independent"},
                           {"instrument": "EURUSD", "timeframe": "M1"}, state or {})


def test_multiple_pages_share_one_calculation_and_session_scopes_listeners(database):
    owner = session(database)
    other = session(database, "other")
    a = register(owner)
    b = register(owner, "second")
    c = register(other)
    assert a["task_id"] == b["task_id"] == c["task_id"]
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketStreamTask)) == 1
        assert db.scalar(select(func.count()).select_from(MarketStreamSubscription)) == 3
    ownership = stream.claim()
    assert stream.claim() is None
    stream.commit(ownership, {"type": "bars", "bars": [{"start": 60000, "close": "1.1"}]})
    assert len(stream.events(owner, "page", {})) == 1
    assert len(stream.events(other, "page", {})) == 1


def test_old_cancel_duplicate_register_and_late_register_do_not_remove_new_generation(database):
    owner = session(database)
    register(owner, generation=2)
    stream.cancel(owner, "page", "chart", 1)
    assert register(owner, generation=2)["generation"] == 2
    assert register(owner, generation=1)["stale"]
    stream.cancel(owner, "page", "chart", 2)
    assert register(owner, generation=2)["stale"]
    with database.begin() as db:
        assert not db.scalar(select(MarketStreamSubscription)).active


def test_expired_owner_cannot_publish_after_successor(database):
    owner = session(database)
    info = register(owner)
    old = stream.claim()
    with database.begin() as db:
        db.get(MarketStreamTask, info["task_id"]).lease_until = 0
    successor = stream.claim()
    assert successor["token"] != old["token"]
    with pytest.raises(TimeoutError):
        stream.commit(old, {"type": "bars"})
    stream.commit(successor, {"type": "status", "status": "ready"})


def test_result_sequence_rejects_stale_same_bar_and_recovers_or_resets(database):
    owner = session(database)
    register(owner)
    for i in range(stream.RESULT_LIMIT + 2):
        work = stream.claim()
        stream.commit(work, {"type": "bars", "bars": [{"start": 60000, "close": str(i)}]}, delay_ms=0)
    cursor = {}
    rows = stream.events(owner, "page", cursor)
    assert rows[0]["type"] == "reset" and rows[0]["reason"] == "recovery_budget"
    assert stream.events(owner, "page", cursor) == []
    work = stream.claim()
    stream.commit(work, {"type": "bars", "bars": [{"start": 60000, "close": "latest"}]}, delay_ms=0)
    rows = stream.events(owner, "page", cursor)
    assert len(rows) == 1 and rows[0]["sequence"] == stream.RESULT_LIMIT + 3


def test_session_end_disables_work_and_output(database):
    owner = session(database)
    register(owner)
    with database.begin() as db:
        db.get(LoginSession, owner).expires = 0
    assert stream.claim() is None
    with pytest.raises(PermissionError):
        stream.events(owner, "page", {})


def test_unconfirmed_previous_minute_retraction_requires_history_restore(database):
    owner = session(database)
    register(owner)
    work = stream.claim()
    stream.commit(work, {"type": "bars", "bars": [{"start": 0}, {"start": 60000}]}, delay_ms=0)
    cursor = {}
    assert stream.events(owner, "page", cursor)[0]["type"] == "bars"
    work = stream.claim()
    stream.commit(work, {"type": "bars", "bars": [{"start": 0}, {"start": 120000}]}, delay_ms=0)
    event = stream.events(owner, "page", cursor)[0]
    assert event["type"] == "reset" and event["reason"] == "tail_retracted"


def test_new_generation_starts_at_latest_snapshot_and_same_generation_replays(database):
    owner = session(database)
    register(owner)
    for i in range(3):
        stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000, "close": str(i)}]}, delay_ms=0)
    register(owner, generation=2)
    cursor = {}
    rows = stream.events(owner, "page", cursor)
    assert len(rows) == 1 and rows[0]["sequence"] == 3 and rows[0]["bars"][0]["close"] == "2"
    register(owner, generation=2, state={"sequence": 2})
    assert stream.events(owner, "page", {})[0]["sequence"] == 3


def test_worker_affinity_keeps_current_bucket_owner_until_failure_takeover(database):
    owner = session(database)
    info = register(owner)
    work = stream.claim(owner="worker-one")
    stream.commit(work, {"type": "status", "status": "ready"}, delay_ms=0)
    assert stream.claim(owner="worker-two") is None
    work = stream.claim(owner="worker-one")
    stream.commit(work, None, delay_ms=0)
    with database.begin() as db:
        db.get(MarketStreamTask, info["task_id"]).owner_until = 0
    assert stream.claim(owner="worker-two") is not None
